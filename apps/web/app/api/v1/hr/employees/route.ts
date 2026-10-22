import { createEmployee, listEmployees } from "@reales/domain";
import { employeeListQuery, employeeSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: employeeListQuery }, async ({ ctx, sq, query }) => listEmployees(sq, ctx, query));
export const POST = api({ body: employeeSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createEmployee(sq, ctx, body) }));
