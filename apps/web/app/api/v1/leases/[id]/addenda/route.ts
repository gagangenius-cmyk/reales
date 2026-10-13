import { addAddendum } from "@reales/domain";
import { addendumSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof addendumSchema>({ body: addendumSchema }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await addAddendum(sq, ctx, uuid.parse(params.id), body) }));
