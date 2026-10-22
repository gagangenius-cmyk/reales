import { createHash, createHmac } from "node:crypto";
import type { ObjectStorage } from "./storage";

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const encodeUri = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput { method: string; host: string; path: string; query?: string; headers?: Record<string, string>; payloadHash: string; accessKey: string; secretKey: string; region: string; service?: string; amzDate: string }

/** AWS Signature Version 4 (header form). Returns the headers to send, including Authorization. Pure, so it can be checked against AWS's published test vector. */
export function signAwsV4(i: SignInput): { headers: Record<string, string>; signature: string; canonicalRequest: string } {
  const service = i.service ?? "s3";
  const date = i.amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(i.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: i.host, "x-amz-content-sha256": i.payloadHash, "x-amz-date": i.amzDate };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [i.method, i.path, i.query ?? "", canonicalHeaders, signedHeaders, i.payloadHash].join("\n");
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.secretKey}`, date), i.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, signature, canonicalRequest };
}

export interface S3Config { endpoint: string; bucket: string; accessKey: string; secretKey: string; region?: string }

/**
 * S3-compatible object storage (AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces) over plain fetch with SigV4, path-style addressing.
 * Needed wherever the filesystem is not durable (serverless platforms): the local driver is for development only.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly base: URL;
  private readonly region: string;
  constructor(private readonly cfg: S3Config) {
    this.base = new URL(cfg.endpoint);
    this.region = cfg.region ?? "us-east-1";
  }
  private url(key: string) { return { host: this.base.host, path: `${this.base.pathname.replace(/\/$/, "")}/${encodeUri(this.cfg.bucket)}/${key.split("/").map(encodeUri).join("/")}` }; }
  private async send(method: "GET" | "PUT" | "HEAD", key: string, body?: Buffer, contentType?: string) {
    const { host, path } = this.url(key);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const payloadHash = sha256(body ?? "");
    const { headers } = signAwsV4({ method, host, path, headers: contentType ? { "content-type": contentType } : {}, payloadHash, accessKey: this.cfg.accessKey, secretKey: this.cfg.secretKey, region: this.region, amzDate });
    const { host: _h, ...sendHeaders } = headers;
    return fetch(`${this.base.protocol}//${host}${path}`, { method, headers: sendHeaders, body: body ? new Uint8Array(body) : undefined });
  }
  async put(key: string, bytes: Buffer) {
    const r = await this.send("PUT", key, bytes, "application/octet-stream");
    if (!r.ok) throw new Error(`Object storage write failed (${r.status})`);
  }
  async get(key: string) {
    const r = await this.send("GET", key);
    if (!r.ok) throw new Error(`Object storage read failed (${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }
  async exists(key: string) {
    const r = await this.send("HEAD", key);
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`Object storage lookup failed (${r.status})`);
    return true;
  }
}

export function s3FromEnv(env: NodeJS.ProcessEnv = process.env): S3ObjectStorage | null {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) return null;
  return new S3ObjectStorage({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY, region: env.S3_REGION });
}
