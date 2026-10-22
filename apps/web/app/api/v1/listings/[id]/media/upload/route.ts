import { uploadListingMedia } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";
import { readUpload } from "@/lib/uploads";

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

/** multipart/form-data: file (JPEG, PNG or WEBP), optional kind=floorplan and caption. */
export const POST = api<{ id: string }>({}, async ({ req, ctx, sq, params }) => {
  const { form, file } = await readUpload(req, MAX_PHOTO_BYTES);
  const kind = form.get("kind") === "floorplan" ? "floorplan" : "image";
  const caption = typeof form.get("caption") === "string" ? String(form.get("caption")) : undefined;
  return { status: 201, data: await uploadListingMedia(sq, ctx, z.string().uuid().parse(params.id), file, { kind, caption }) };
});
