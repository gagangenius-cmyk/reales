import { adjustPayslip } from "@reales/domain";
import { payslipAdjustSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof payslipAdjustSchema>({ body: payslipAdjustSchema, idempotent: true }, async ({ ctx, sq, params, body }) => adjustPayslip(sq, ctx, z.string().uuid().parse(params.id), body));
