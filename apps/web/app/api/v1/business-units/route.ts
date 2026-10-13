import { createBusinessUnit } from "@reales/domain";
import { createBusinessUnitSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: createBusinessUnitSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createBusinessUnit(sq, ctx, body) }));
