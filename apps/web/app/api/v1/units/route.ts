import { createUnit, listUnits } from "@reales/domain";
import { unitListQuery, unitSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: unitListQuery }, async ({ ctx, sq, query }) => ({ units: await listUnits(sq, ctx, query) }));
export const POST = api({ body: unitSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createUnit(sq, ctx, body) }));
