import { encashLeave, listEncashments } from "@reales/domain";
import { encashSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => listEncashments(sq, ctx, z.string().uuid().parse(params.id)));
export const POST = api<{ id: string }, typeof encashSchema>({ body: encashSchema, idempotent: true }, async ({ ctx, sq, params, body }) => encashLeave(sq, ctx, z.string().uuid().parse(params.id), body));
