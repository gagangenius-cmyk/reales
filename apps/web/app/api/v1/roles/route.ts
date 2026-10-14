import { createCustomRole, listRoles } from "@reales/domain";
import { createRoleSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ roles: await listRoles(sq, ctx) }));
export const POST = api({ body: createRoleSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createCustomRole(sq, ctx, body) }));
