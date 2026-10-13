import { setPaymentPlan } from "@reales/domain";
import { paymentPlanSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof paymentPlanSchema>({ body: paymentPlanSchema }, async ({ ctx, sq, body, params }) => setPaymentPlan(sq, ctx, uuid.parse(params.id), body.installments));
