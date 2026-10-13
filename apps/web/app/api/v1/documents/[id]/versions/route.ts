import { addDocumentVersion, MAX_UPLOAD_BYTES } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";
import { readUpload } from "@/lib/uploads";

const uuid = z.string().uuid();

export const POST = api<{ id: string }>({}, async ({ req, ctx, sq, params }) => {
  const { file } = await readUpload(req, MAX_UPLOAD_BYTES);
  return { status: 201, data: await addDocumentVersion(sq, ctx, uuid.parse(params.id), file) };
});
