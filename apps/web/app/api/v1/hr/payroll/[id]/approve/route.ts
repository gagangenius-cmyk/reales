import { requireStepUp } from "@reales/auth";
import { approvePayrollRun } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

/** Approving freezes and numbers the payslips, so it needs the second factor. */
export const POST = api<{ id: string }>({ idempotent: true }, async ({ ctx, sq, params }) => { requireStepUp(ctx); return approvePayrollRun(sq, ctx, z.string().uuid().parse(params.id)); });
