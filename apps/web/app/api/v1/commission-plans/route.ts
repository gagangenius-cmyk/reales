import { createCommissionPlan, listCommissionPlans } from "@reales/domain";
import { commissionPlanSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ plans: await listCommissionPlans(sq, ctx) }));
export const POST = api({ body: commissionPlanSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createCommissionPlan(sq, ctx, body) }));
