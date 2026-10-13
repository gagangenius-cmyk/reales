import { assignRole } from "@reales/domain";
import { assignRoleSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const idParam = z.string().uuid();

export const POST = api<{ id: string }, typeof assignRoleSchema>({ body: assignRoleSchema }, async ({ ctx, sq, body, params }) => {
  await assignRole(sq, ctx, idParam.parse(params.id), body);
  return { status: 201, data: { ok: true } };
});
