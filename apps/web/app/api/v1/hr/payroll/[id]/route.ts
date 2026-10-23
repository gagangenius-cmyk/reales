import { deletePayrollRun, getPayrollRun } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getPayrollRun(sq, ctx, z.string().uuid().parse(params.id)));
export const DELETE = api<{ id: string }>({}, async ({ ctx, sq, params }) => deletePayrollRun(sq, ctx, z.string().uuid().parse(params.id)));
