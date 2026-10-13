import { linkDocument } from "@reales/domain";
import { linkSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof linkSchema>({ body: linkSchema }, async ({ ctx, sq, body, params }) => {
  await linkDocument(sq, ctx, uuid.parse(params.id), body);
  return { status: 201, data: { ok: true } };
});
