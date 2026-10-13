import { advanceDealStage } from "@reales/domain";
import { dealStageSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

/** Returns 422 with the blocking reasons when a gate (deposit, signature, instalments, ...) is not satisfied. */
export const POST = api<{ id: string }, typeof dealStageSchema>({ body: dealStageSchema }, async ({ ctx, sq, body, params }) => advanceDealStage(sq, ctx, uuid.parse(params.id), body));
