import { revokeUserRole } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const idParam = z.string().uuid();

export const DELETE = api<{ id: string; userRoleId: string }>({}, async ({ ctx, sq, params }) => {
  await revokeUserRole(sq, ctx, idParam.parse(params.id), idParam.parse(params.userRoleId));
  return { ok: true };
});
