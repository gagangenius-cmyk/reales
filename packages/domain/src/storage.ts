import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "@reales/observability";
import { s3FromEnv } from "./storage-s3";

/** S3-compatible object storage sits behind this interface; dev uses the local filesystem driver. */
export interface ObjectStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

// Keys are `<tenantId>/<sha256>`: content-addressed, tenant-prefixed, and impossible to use for path traversal.
const KEY = /^[0-9a-f-]{36}\/[0-9a-f]{64}$/;

export class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly root: string) {}
  private file(key: string) {
    if (!KEY.test(key)) throw new Error("Invalid storage key");
    return path.join(this.root, ...key.split("/"));
  }
  async put(key: string, bytes: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, bytes, { flag: "w" });
  }
  async get(key: string) {
    return readFile(this.file(key));
  }
  async exists(key: string) {
    try { await stat(this.file(key)); return true; } catch { return false; }
  }
}

let storage: ObjectStorage | null = null;
/** S3-compatible storage when S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY are set (required on serverless hosts); otherwise the local folder (development). */
export function getStorage(): ObjectStorage {
  if (!storage) {
    const s3 = s3FromEnv();
    storage = s3 ?? new LocalObjectStorage(process.env.STORAGE_LOCAL_DIR ?? path.resolve(process.cwd(), ".storage"));
    if (!s3 && process.env.VERCEL) logger.warn("Object storage is the local filesystem on a serverless host: uploads will not persist. Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY.");
  }
  return storage;
}
export const setStorage = (s: ObjectStorage | null) => void (storage = s);

export const storageKeyFor = (tenantId: string, hash: string) => `${tenantId}/${hash}`;
export const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- upload validation and malware scanning
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const SIGNATURES: Array<{ mime: string; ext: string[]; test: (b: Buffer) => boolean }> = [
  { mime: "application/pdf", ext: [".pdf"], test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", ext: [".png"], test: (b) => b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG" },
  { mime: "image/webp", ext: [".webp"], test: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { mime: "image/jpeg", ext: [".jpg", ".jpeg"], test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: [".docx"], test: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: [".xlsx"], test: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
];

export class UploadRejectedError extends Error {
  status = 422;
  constructor(message: string) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

export interface ValidatedUpload { filename: string; mime: string; bytes: Buffer; hash: string }

/**
 * Allow-list by content (magic bytes), not by the client's claim: the declared type and extension must agree with the
 * sniffed type. HTML, SVG, scripts and executables are never accepted (stored-XSS / malware vectors).
 */
export function validateUpload(input: { filename: string; mime?: string; bytes: Buffer }): ValidatedUpload {
  const { bytes } = input;
  if (!bytes.length) throw new UploadRejectedError("The file is empty");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadRejectedError(`The file exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`);
  const base = path.basename(input.filename.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "").trim().slice(0, 200);
  if (!base || base.startsWith(".")) throw new UploadRejectedError("Invalid file name");
  const ext = path.extname(base).toLowerCase();
  const sniffed = SIGNATURES.find((s) => s.test(bytes) && s.ext.includes(ext));
  if (!sniffed) throw new UploadRejectedError("Unsupported or mismatched file type (allowed: PDF, PNG, JPEG, WEBP, DOCX, XLSX)");
  if (input.mime && input.mime !== sniffed.mime && !(input.mime === "application/octet-stream")) throw new UploadRejectedError("Declared file type does not match the file content");
  return { filename: base, mime: sniffed.mime, bytes, hash: sha256Hex(bytes) };
}

export interface ContentScanner { scan(bytes: Buffer, filename: string): Promise<{ clean: boolean; reason?: string }> }

let scanner: ContentScanner | null = null;
export const setContentScanner = (s: ContentScanner | null) => void (scanner = s);

/** Hook for malware scanning (e.g. ClamAV). Production must configure one; without it uploads are refused when REQUIRE_MALWARE_SCANNER=1. */
export async function scanUpload(u: ValidatedUpload): Promise<void> {
  if (!scanner) {
    if (process.env.REQUIRE_MALWARE_SCANNER === "1") throw new UploadRejectedError("Uploads are disabled: no malware scanner is configured");
    logger.debug("no malware scanner configured; upload accepted after type validation only");
    return;
  }
  const r = await scanner.scan(u.bytes, u.filename);
  if (!r.clean) throw new UploadRejectedError(`Upload rejected by malware scan${r.reason ? `: ${r.reason}` : ""}`);
}
