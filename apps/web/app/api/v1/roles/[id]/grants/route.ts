import { deleteCustomRole, getRoleGrants, setRoleGrants } from "@reales/domain";
import { setRoleGrantsSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const idParam = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => ({ grants: await getRoleGrants(sq, ctx, idParam.parse(params.id)) }));
export const PUT = api<{ id: string }, typeof setRoleGrantsSchema>({ body: setRoleGrantsSchema }, async ({ ctx, sq, params, body }) => setRoleGrants(sq, ctx, idParam.parse(params.id), body));
export const DELETE = api<{ id: string }>({}, async ({ ctx, sq, params }) => {
  await deleteCustomRole(sq, ctx, idParam.parse(params.id));
  return { ok: true };
});
