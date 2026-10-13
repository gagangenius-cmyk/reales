import { randomUUID } from "node:crypto";
import { authenticator } from "otplib";
import { Sequelize } from "sequelize";
import { createSequelize, dbConfigFromEnv, RequestContext } from "@reales/database";
import { bootstrapTenant, createUser } from "@reales/domain";
import { loadAccess } from "@reales/rbac";

export const PASSWORD = "Str0ng-Passw0rd!x";

let sq: Sequelize | null = null;
export function testDb(): Sequelize {
  sq ??= createSequelize(dbConfigFromEnv(true));
  return sq;
}
export async function closeTestDb() {
  await sq?.close();
  sq = null;
}

export const uniq = (p = "t") => `${p}-${randomUUID().slice(0, 8)}`;

/** Build a RequestContext directly (bypasses sessions) for domain-level tests. */
export async function contextFor(tenantId: string, userId: string, opts: { stepUp?: boolean } = {}): Promise<RequestContext> {
  const access = await loadAccess(testDb(), tenantId, userId);
  return {
    tenantId, userId, sessionId: randomUUID(), correlationId: `corr_${randomUUID()}`,
    grants: access.grants, membership: access.membership, stepUpValid: !!opts.stepUp,
  };
}

export async function makeTenant(name = uniq("tenant")) {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const email = `admin@${slug}.test`;
  const t = await bootstrapTenant(testDb(), { name, slug, adminEmail: email, adminPassword: PASSWORD });
  return { ...t, slug, adminEmail: email, admin: await contextFor(t.tenantId, t.adminId, { stepUp: true }) };
}

/** Create a user with the given role keys inside the tenant, returning their context. */
export async function makeUser(tenant: Awaited<ReturnType<typeof makeTenant>>, roleKeys: string[], extra: { branchId?: string; businessUnitId?: string } = {}) {
  const email = `${uniq("u")}@${tenant.slug}.test`;
  const u = await createUser(testDb(), tenant.admin, { email, password: PASSWORD, roleKeys, ...extra });
  return { id: u.id as string, email, ctx: await contextFor(tenant.tenantId, u.id as string) };
}

export const totpNow = (secret: string, offsetSteps = 0) =>
  authenticator.clone({ epoch: Date.now() + offsetSteps * 30_000, window: 0 }).generate(secret);
