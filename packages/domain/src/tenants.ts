import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { assertPasswordPolicy, hashPassword } from "@reales/auth";
import { recordAudit } from "@reales/database";
import { emitEvent } from "@reales/events";
import { seedTenantRoles } from "@reales/rbac";
import { seedTenantDefaults } from "./defaults";
import { seedRegulatory } from "./regulatory";
import { ConflictError } from "./uow";

export const DEFAULT_PLANS = [
  { code: "starter", name: "Starter", limits: { users: 10, listings: 200, contacts: 5000 }, features: ["crm", "inventory"] },
  { code: "professional", name: "Professional", limits: { users: 50, listings: 2000, contacts: 50000 }, features: ["crm", "inventory", "portals", "automation", "whatsapp"] },
  { code: "enterprise", name: "Enterprise", limits: { users: 1000, listings: 100000, contacts: 2000000 }, features: ["crm", "inventory", "portals", "automation", "whatsapp", "bi", "api", "ai", "sso"] },
];

export async function seedPlans(sq: Sequelize) {
  for (const p of DEFAULT_PLANS) {
    await sq.query("INSERT INTO plans (id, code, name, limits, created_at, updated_at) VALUES (UUID(), :code, :name, :limits, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE name=VALUES(name), limits=VALUES(limits)", {
      replacements: { code: p.code, name: p.name, limits: JSON.stringify(p.limits) },
    });
    for (const f of p.features) {
      await sq.query("INSERT INTO features (id, code, created_at, updated_at) VALUES (UUID(), :f, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE code=code", { replacements: { f } });
      await sq.query(
        "INSERT IGNORE INTO plan_features (plan_id, feature_id) SELECT p.id, f.id FROM plans p, features f WHERE p.code=:pc AND f.code=:f",
        { replacements: { pc: p.code, f } },
      );
    }
  }
}

export interface BootstrapTenantInput {
  name: string;
  slug: string;
  adminEmail: string;
  adminPassword: string;
  jurisdiction?: string; // DUBAI_MAINLAND | ABU_DHABI_MAINLAND | ADGM | DIFC ...
  dataRegion?: string;
  planCode?: string;
}

/** Provision a tenant with plan entitlements/quotas, system roles and its first administrator. */
export async function bootstrapTenant(sq: Sequelize, input: BootstrapTenantInput) {
  assertPasswordPolicy(input.adminPassword);
  if (!/^[a-z0-9][a-z0-9-]{1,98}$/.test(input.slug)) throw new Error("Invalid tenant slug");
  await seedPlans(sq);
  await seedRegulatory(sq);
  const passwordHash = await hashPassword(input.adminPassword);
  const tenantId = randomUUID();
  const adminId = randomUUID();
  const correlationId = `corr_${randomUUID()}`;
  const planCode = input.planCode ?? "professional";

  const [existing] = await sq.query("SELECT id FROM tenants WHERE slug=:slug", { replacements: { slug: input.slug }, type: QueryTypes.SELECT });
  if (existing) throw new ConflictError("Tenant slug already exists");

  await sq.transaction(async (tx) => {
    await sq.query(
      "INSERT INTO tenants (id, name, slug, status, data_region, jurisdiction, country, created_at, updated_at) VALUES (:id, :name, :slug, 'active', :region, :jur, 'AE', NOW(3), NOW(3))",
      { transaction: tx, replacements: { id: tenantId, name: input.name, slug: input.slug, region: input.dataRegion ?? "ae-uae", jur: input.jurisdiction ?? "DUBAI_MAINLAND" } },
    );
    const [plan] = await sq.query<{ id: string; limits: any }>("SELECT id, limits FROM plans WHERE code=:c", { transaction: tx, replacements: { c: planCode }, type: QueryTypes.SELECT });
    if (!plan) throw new Error(`Unknown plan ${planCode}`);
    await sq.query("INSERT INTO subscriptions (id, tenant_id, plan_id, status, starts_at, created_at, updated_at) VALUES (UUID(), :t, :p, 'active', NOW(3), NOW(3), NOW(3))", {
      transaction: tx, replacements: { t: tenantId, p: plan.id },
    });
    await sq.query(
      "INSERT INTO tenant_entitlements (id, tenant_id, feature_code, enabled, created_at, updated_at) SELECT UUID(), :t, f.code, 1, NOW(3), NOW(3) FROM plan_features pf JOIN features f ON f.id = pf.feature_id WHERE pf.plan_id = :p",
      { transaction: tx, replacements: { t: tenantId, p: plan.id } },
    );
    const limits = typeof plan.limits === "string" ? JSON.parse(plan.limits) : plan.limits ?? {};
    for (const [k, v] of Object.entries(limits)) {
      await sq.query("INSERT INTO tenant_quotas (id, tenant_id, quota_key, limit_value, created_at, updated_at) VALUES (UUID(), :t, :k, :v, NOW(3), NOW(3))", {
        transaction: tx, replacements: { t: tenantId, k, v: Number(v) },
      });
    }
    await sq.query(
      "INSERT INTO users (id, tenant_id, email, normalized_email, password_hash, status, failed_login_count, created_at, updated_at) VALUES (:id, :t, :email, :ne, :h, 'active', 0, NOW(3), NOW(3))",
      { transaction: tx, replacements: { id: adminId, t: tenantId, email: input.adminEmail.trim(), ne: input.adminEmail.trim().toLowerCase(), h: passwordHash } },
    );
    await sq.query("INSERT INTO user_profiles (user_id, tenant_id, locale, timezone, created_at, updated_at) VALUES (:u, :t, 'en', 'Asia/Dubai', NOW(3), NOW(3))", {
      transaction: tx, replacements: { u: adminId, t: tenantId },
    });
  });

  // Roles are created after the tenant row is committed (seedTenantRoles uses its own statements), then admin is assigned.
  const roleIds = await seedTenantRoles(sq, tenantId);
  await sq.transaction(async (tx) => {
    await sq.query("INSERT INTO user_roles (id, tenant_id, user_id, role_id, created_at, updated_at) VALUES (UUID(), :t, :u, :r, NOW(3), NOW(3))", {
      transaction: tx, replacements: { t: tenantId, u: adminId, r: roleIds.tenant_admin },
    });
    await recordAudit(sq, tx, { tenantId, actorId: "system", action: "tenant.created", entityType: "tenant", entityId: tenantId, after: { slug: input.slug, plan: planCode, jurisdiction: input.jurisdiction ?? "DUBAI_MAINLAND" }, correlationId });
    await emitEvent(sq, tx, { tenantId, userId: "system", correlationId }, { type: "tenant.created", aggregateType: "tenant", aggregateId: tenantId, payload: { slug: input.slug } });
  });
  await seedTenantDefaults(sq, tenantId);
  return { tenantId, adminId, roleIds };
}
