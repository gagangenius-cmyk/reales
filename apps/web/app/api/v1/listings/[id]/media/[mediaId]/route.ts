import { NextResponse } from "next/server";
import { deleteListingMedia, readListingMedia, updateListingMedia } from "@reales/domain";
import { mediaPatchSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const id = z.string().uuid();

/** The photo itself, for signed-in users who can see the listing. Private cache, never sniffed as HTML. */
export const GET = api<{ id: string; mediaId: string }>({}, async ({ ctx, sq, params }) => {
  const m = await readListingMedia(sq, ctx, id.parse(params.id), id.parse(params.mediaId));
  return new NextResponse(new Uint8Array(m.bytes), { headers: { "content-type": m.mime, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "content-disposition": `inline; filename="${m.filename.replace(/[^\w.-]/g, "_")}"` } });
});
export const PATCH = api<{ id: string; mediaId: string }, typeof mediaPatchSchema>({ body: mediaPatchSchema }, async ({ ctx, sq, params, body }) => {
  await updateListingMedia(sq, ctx, id.parse(params.id), id.parse(params.mediaId), body);
  return { ok: true };
});
export const DELETE = api<{ id: string; mediaId: string }>({}, async ({ ctx, sq, params }) => {
  await deleteListingMedia(sq, ctx, id.parse(params.id), id.parse(params.mediaId));
  return { ok: true };
});
