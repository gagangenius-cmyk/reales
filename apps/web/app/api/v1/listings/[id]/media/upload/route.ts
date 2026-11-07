import { uploadListingMedia, uploadListingVideo } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";
import { readUpload } from "@/lib/uploads";

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
/** Vercel functions reject request bodies over ~4.5 MB, so there the limit is lower; elsewhere videos may be up to 100 MB. Share bigger videos as a YouTube link. */
const MAX_VIDEO_BYTES = process.env.VERCEL ? 4 * 1024 * 1024 : 100 * 1024 * 1024;

/** multipart/form-data: file (JPEG, PNG or WEBP; or MP4, MOV, WEBM with kind=video), optional kind=floorplan and caption. */
export const POST = api<{ id: string }>({}, async ({ req, ctx, sq, params }) => {
  const isVideo = new URL(req.url).searchParams.get("kind") === "video";
  const { form, file } = await readUpload(req, isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES);
  if (isVideo || form.get("kind") === "video") return { status: 201, data: await uploadListingVideo(sq, ctx, z.string().uuid().parse(params.id), file, { caption: typeof form.get("caption") === "string" ? String(form.get("caption")) : undefined, maxBytes: MAX_VIDEO_BYTES }) };
  const kind = form.get("kind") === "floorplan" ? "floorplan" : "image";
  const caption = typeof form.get("caption") === "string" ? String(form.get("caption")) : undefined;
  return { status: 201, data: await uploadListingMedia(sq, ctx, z.string().uuid().parse(params.id), file, { kind, caption }) };
});
