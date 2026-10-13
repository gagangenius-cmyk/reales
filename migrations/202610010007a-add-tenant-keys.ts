import { Ctx, tenantKey } from "./_helpers";

/** Phase-1 parents that later tables reference with tenant-safe composite foreign keys. */
const PARENTS = ["users", "business_units", "branches", "teams", "projects", "roles"];

export async function up({ context: qi }: Ctx) {
  for (const t of PARENTS) await tenantKey(qi, t);
}
export async function down({ context: qi }: Ctx) {
  for (const t of PARENTS) await qi.removeIndex(t, `uq_${t}_tenant_id`);
}
