import "dotenv/config";
import { QueryTypes } from "sequelize";
import { closeSequelize, getSequelize } from "../packages/database/src";
import { seedTenantRoles } from "../packages/rbac/src";

/** Re-applies the system role templates and permission catalogue to every tenant (after new permissions are added). Custom roles are untouched. */
async function main() {
  const sq = getSequelize();
  const tenants = await sq.query<{ id: string; slug: string }>("SELECT id, slug FROM tenants", { type: QueryTypes.SELECT });
  for (const t of tenants) { await seedTenantRoles(sq, t.id); console.log(`synced roles for ${t.slug}`); }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => closeSequelize());
