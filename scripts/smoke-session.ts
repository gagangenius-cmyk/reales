import "dotenv/config";
import { writeFileSync } from "node:fs";
import { QueryTypes } from "sequelize";
import { getSequelize, closeSequelize, systemContext } from "../packages/database/src";
import { bootstrapTenant, createEmployee, createListingFromProperty, createLead, setSalary } from "../packages/domain/src";
import { issueSession } from "../packages/auth/src";
import { PERMISSIONS, loadAccess } from "../packages/rbac/src";

/** Developer smoke test helper: creates (or reuses) a workspace with sample data in the DATABASE THE ENV POINTS AT and writes a session token to the given file. Never run against production. */
async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: tsx scripts/smoke-session.ts <token-file>");
  const sq = getSequelize();
  let [t] = await sq.query<{ id: string }>("SELECT id FROM tenants WHERE slug='smoke'", { type: QueryTypes.SELECT });
  let adminId: string;
  if (!t) {
    const b: any = await bootstrapTenant(sq, { name: "Smoke Realty", slug: "smoke", adminEmail: "admin@smoke.test", adminPassword: "Str0ng-Passw0rd!x" });
    t = { id: b.tenantId }; adminId = b.adminId;
  } else {
    [{ id: adminId }] = (await sq.query<{ id: string }>("SELECT id FROM users WHERE tenant_id=:t AND email='admin@smoke.test'", { replacements: { t: t.id }, type: QueryTypes.SELECT })) as [{ id: string }];
  }
  const access: any = await loadAccess(sq, t.id, adminId);
  const ctx = { tenantId: t.id, userId: adminId, sessionId: "smoke", correlationId: "smoke", grants: access.grants, membership: access.membership, stepUpValid: true };
  void PERMISSIONS; void systemContext;
  const [n] = await sq.query<{ n: number }>("SELECT COUNT(*) AS n FROM hr_employees WHERE tenant_id=:t", { replacements: { t: t.id }, type: QueryTypes.SELECT });
  if (!n || Number(n.n) === 0) {
    const emp: any = await createEmployee(sq, ctx as never, { fullName: "Smoke Employee", joinedOn: "2024-01-15", designation: "Agent", department: "Sales", userId: adminId, dateOfBirth: "1992-04-05", email: "admin@smoke.test" });
    await setSalary(sq, ctx as never, emp.id, { effectiveFrom: "2024-01-15", basic: 9000, housing: 3000, transport: 1000 });
    await createListingFromProperty(sq, ctx as never, { emirate: "Dubai", community: "Dubai Marina", subCommunity: "Marina Promenade", buildingName: "Smoke Tower", unitNumber: "101", type: "apartment", purpose: "sale", price: 1_800_000, bedrooms: 2, bathrooms: 2, builtUpAreaSqft: 1100, latitude: 25.0805, longitude: 55.1403 });
    await createLead(sq, ctx as never, { contact: { firstName: "Smoke", lastName: "Lead", phone: "0501234567" }, purpose: "buy", sourceCode: "walk_in" } as never);
  }
  const s: any = await issueSession(sq, { tenantId: t.id, userId: adminId, email: "admin@smoke.test", mfaVerified: true });
  writeFileSync(out, String(s.token ?? s.sessionToken));
  console.log("session written", Object.keys(s));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => closeSequelize());
