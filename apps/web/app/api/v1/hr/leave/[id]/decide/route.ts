import { decideLeave } from "@reales/domain";
import { leaveDecisionSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof leaveDecisionSchema>({ body: leaveDecisionSchema, idempotent: true }, async ({ ctx, sq, params, body }) => decideLeave(sq, ctx, z.string().uuid().parse(params.id), body));
