import { triageTicket } from "@reales/domain";
import { triageSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof triageSchema>({ body: triageSchema }, async ({ ctx, sq, params, body }) => triageTicket(sq, ctx, uuid.parse(params.id), body));
