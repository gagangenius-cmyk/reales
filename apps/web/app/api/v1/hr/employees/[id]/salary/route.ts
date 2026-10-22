import { getSalaryHistory, setSalary } from "@reales/domain";
import { salarySchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getSalaryHistory(sq, ctx, z.string().uuid().parse(params.id)));
export const PUT = api<{ id: string }, typeof salarySchema>({ body: salarySchema, idempotent: true }, async ({ ctx, sq, params, body }) => setSalary(sq, ctx, z.string().uuid().parse(params.id), body));
