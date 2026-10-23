import { markPayrollPaid } from "@reales/domain";
import { payrollPaidSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof payrollPaidSchema>({ body: payrollPaidSchema, idempotent: true }, async ({ ctx, sq, params, body }) => markPayrollPaid(sq, ctx, z.string().uuid().parse(params.id), body));
