import { addListingMedia } from "@reales/domain";
import { mediaSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof mediaSchema>({ body: mediaSchema }, async ({ ctx, sq, body, params }) => {
  const id = uuid.parse(params.id);
  return { status: 201, data: await addListingMedia(sq, ctx, id, body) };
});
