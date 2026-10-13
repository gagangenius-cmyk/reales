import type { NextRequest } from "next/server";
import { UploadRejectedError } from "@reales/domain";

/**
 * Read a multipart upload with a hard size cap. The Content-Length check rejects oversized requests before the body is buffered
 * (it is only a first line of defence; the domain layer re-validates size and content type on the actual bytes).
 */
export async function readUpload(req: NextRequest, maxBytes: number) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes + 1024 * 1024) throw new UploadRejectedError("The upload is too large");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) throw new UploadRejectedError("Expected multipart/form-data");
  const form = await req.formData();
  const f = form.get("file");
  if (!f || typeof f === "string") throw new UploadRejectedError("A file is required in the 'file' field");
  const bytes = Buffer.from(await (f as File).arrayBuffer());
  return { form, file: { filename: (f as File).name, mime: (f as File).type || undefined, bytes } };
}
