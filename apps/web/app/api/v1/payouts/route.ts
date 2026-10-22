import { listPayouts, requestPayout } from "@reales/domain";
import { payoutRequestSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: z.object({ status: z.string().max(20).optional() }) }, async ({ ctx, sq, query }) => ({ payouts: await listPayouts(sq, ctx, query) }));
export const POST = api({ body: payoutRequestSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await requestPayout(sq, ctx, body) }));
