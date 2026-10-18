import "dotenv/config";
import { QueryTypes } from "sequelize";
import { closeSequelize, getSequelize } from "../packages/database/src";
import { seedTenantRoles } from "../packages/rbac/src";

/** Re-syncs the permission catalogue and the system roles of every workspace from the templates in packages/rbac. Custom roles are untouched. */
async function main() {
  const sq = getSequelize();
  const tenants = await sq.query<{ id: string; slug: string }>("SELECT id, slug FROM tenants", { type: QueryTypes.SELECT });
  for (const t of tenants) { await seedTenantRoles(sq, t.id); console.log(`Roles synced for "${t.slug}"`); }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => closeSequelize());
