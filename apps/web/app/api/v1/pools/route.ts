import { listPools, savePool } from "@reales/domain";
import { poolSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ pools: await listPools(sq, ctx) }));
export const POST = api({ body: poolSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: body.id ? 200 : 201, data: await savePool(sq, ctx, body) }));
