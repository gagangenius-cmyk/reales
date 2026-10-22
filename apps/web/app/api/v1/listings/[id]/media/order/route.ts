import { reorderListingMedia } from "@reales/domain";
import { mediaOrderSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const PUT = api<{ id: string }, typeof mediaOrderSchema>({ body: mediaOrderSchema }, async ({ ctx, sq, params, body }) => {
  await reorderListingMedia(sq, ctx, z.string().uuid().parse(params.id), body.ids);
  return { ok: true };
});
