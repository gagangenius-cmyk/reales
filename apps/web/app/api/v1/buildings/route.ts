import { createBuilding } from "@reales/domain";
import { buildingSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: buildingSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createBuilding(sq, ctx, body) }));
