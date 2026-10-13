import { createDeal, listDeals } from "@reales/domain";
import { createDealSchema, dealListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: dealListQuery }, async ({ ctx, sq, query }) => ({ deals: await listDeals(sq, ctx, query) }));
export const POST = api({ body: createDealSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createDeal(sq, ctx, body) }));
