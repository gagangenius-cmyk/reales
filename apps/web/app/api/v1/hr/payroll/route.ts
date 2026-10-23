import { createPayrollRun, listPayrollRuns } from "@reales/domain";
import { payrollCreateSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => listPayrollRuns(sq, ctx));
export const POST = api({ body: payrollCreateSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createPayrollRun(sq, ctx, body.period) }));
