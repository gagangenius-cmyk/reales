import { QueryTypes } from "sequelize";
import { api } from "@/lib/api";

export const GET = api({ auth: "pending-mfa" }, async ({ ctx, sq }) => {
  const [u] = await sq.query<{ email: string; tenant_name: string; slug: string; jurisdiction: string }>(
    "SELECT u.email, t.name AS tenant_name, t.slug, t.jurisdiction FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.tenant_id=:t AND u.id=:u",
    { replacements: { t: ctx.tenantId, u: ctx.userId }, type: QueryTypes.SELECT },
  );
  return {
    userId: ctx.userId, email: u?.email, tenant: { id: ctx.tenantId, name: u?.tenant_name, slug: u?.slug, jurisdiction: u?.jurisdiction },
    permissions: [...new Set(ctx.grants.map((g) => g.permission))].sort(), stepUpValid: ctx.stepUpValid,
  };
});
