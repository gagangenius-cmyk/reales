import "dotenv/config";
import { randomBytes } from "node:crypto";
import { QueryTypes } from "sequelize";
import { PERMISSIONS } from "../packages/rbac/src";
import { closeSequelize, getSequelize, type RequestContext } from "../packages/database/src";
import { createUser } from "../packages/domain/src";

/**
 * Adds a Manager (branch manager role) and an Agent (sales agent role) to an existing workspace so all three sign-in types exist: Admin, Manager and Agent.
 * Configure with env vars: TENANT_SLUG (default "main"), MANAGER_EMAIL, AGENT_EMAIL. Passwords are generated and printed once; people change them after first sign-in.
 */
async function main() {
  const sq = getSequelize();
  const slug = process.env.TENANT_SLUG ?? "main";
  const [tenant] = await sq.query<{ id: string }>("SELECT id FROM tenants WHERE slug=:slug", { replacements: { slug }, type: QueryTypes.SELECT });
  if (!tenant) throw new Error(`No workspace "${slug}". Run npm run db:seed:admin first.`);
  const [admin] = await sq.query<{ id: string; email: string }>("SELECT us.id, us.email FROM users us JOIN user_roles ur ON ur.user_id=us.id AND ur.tenant_id=us.tenant_id JOIN roles r ON r.id=ur.role_id WHERE us.tenant_id=:t AND r.`key`='tenant_admin' ORDER BY us.created_at LIMIT 1", { replacements: { t: tenant.id }, type: QueryTypes.SELECT });
  if (!admin) throw new Error("This workspace has no administrator.");
  const ctx: RequestContext = { tenantId: tenant.id, userId: admin.id, sessionId: "cli", correlationId: "cli-seed-team", grants: (Object.keys(PERMISSIONS) as string[]).map((permission) => ({ permission, scope: "tenant" as const })), membership: { businessUnitIds: [], branchIds: [], projectIds: [], portfolioIds: [] }, stepUpValid: true };
  const people: { role: string; roleKey: string; email: string | undefined }[] = [
    { role: "Manager", roleKey: "branch_manager", email: process.env.MANAGER_EMAIL }, { role: "Agent", roleKey: "agent", email: process.env.AGENT_EMAIL },
  ];
  for (const p of people) {
    if (!p.email) { console.log(`Skipping ${p.role}: set ${p.role.toUpperCase()}_EMAIL`); continue; }
    const [exists] = await sq.query("SELECT id FROM users WHERE tenant_id=:t AND email=:e", { replacements: { t: tenant.id, e: p.email.toLowerCase() }, type: QueryTypes.SELECT });
    if (exists) { console.log(`${p.role} ${p.email} already exists`); continue; }
    const password = randomBytes(9).toString("base64url") + "aA1!";
    await createUser(sq, ctx, { email: p.email, password, roleKeys: [p.roleKey] } as never);
    console.log(`${p.role}: workspace ${slug}  email ${p.email}  password ${password}`);
  }
  console.log(`Admin: ${admin.email}. Managers and agents can be added any time under Users, and roles and permissions edited under Roles.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => closeSequelize());
