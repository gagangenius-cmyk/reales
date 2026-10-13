import { addPermit } from "@reales/domain";
import { permitSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof permitSchema>({ body: permitSchema }, async ({ ctx, sq, body, params }) => {
  const id = uuid.parse(params.id);
  return { status: 201, data: await addPermit(sq, ctx, id, body) };
});
