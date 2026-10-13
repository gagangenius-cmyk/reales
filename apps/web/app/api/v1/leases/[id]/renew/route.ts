import { renewLease } from "@reales/domain";
import { renewSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof renewSchema>({ body: renewSchema }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await renewLease(sq, ctx, uuid.parse(params.id), body) }));
