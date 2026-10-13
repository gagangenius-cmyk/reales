import { decideQuotation } from "@reales/domain";
import { quotationDecisionSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string; qid: string }, typeof quotationDecisionSchema>({ body: quotationDecisionSchema }, async ({ ctx, sq, params, body }) => decideQuotation(sq, ctx, uuid.parse(params.id), uuid.parse(params.qid), body.outcome));
