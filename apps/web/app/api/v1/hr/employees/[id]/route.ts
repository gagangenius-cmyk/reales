import { getEmployee, updateEmployee } from "@reales/domain";
import { employeePatchSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getEmployee(sq, ctx, z.string().uuid().parse(params.id)));
export const PATCH = api<{ id: string }, typeof employeePatchSchema>({ body: employeePatchSchema }, async ({ ctx, sq, params, body }) => updateEmployee(sq, ctx, z.string().uuid().parse(params.id), body));
