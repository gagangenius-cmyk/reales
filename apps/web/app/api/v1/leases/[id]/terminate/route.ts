import { terminateLease } from "@reales/domain";
import { terminateSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof terminateSchema>({ body: terminateSchema }, async ({ ctx, sq, params, body }) => terminateLease(sq, ctx, uuid.parse(params.id), body));
