import { setTarget, targetProgress } from "@reales/domain";
import { targetQuery, targetSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: targetQuery }, async ({ ctx, sq, query }) => ({ targets: await targetProgress(sq, ctx, { periodType: query.period, date: query.date }) }));
export const PUT = api({ body: targetSchema, idempotent: true }, async ({ ctx, sq, body }) => setTarget(sq, ctx, body));
