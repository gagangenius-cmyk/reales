import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json } from "./_helpers";

export async function up({ context: qi }: Ctx) {
  await qi.createTable("plans", { id: id(), code: str(40), name: str(120), limits: json(), ...ts() });
  await qi.addIndex("plans", ["code"], { unique: true, name: "uq_plans_code" });

  await qi.createTable("features", { id: id(), code: str(60), description: str(255, true), ...ts() });
  await qi.addIndex("features", ["code"], { unique: true, name: "uq_features_code" });

  await qi.createTable("plan_features", {
    plan_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "plans", key: "id" } },
    feature_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "features", key: "id" } },
  });

  await qi.createTable("subscriptions", {
    id: id(), tenant_id: tenantId(),
    plan_id: { ...uuid(false), references: { model: "plans", key: "id" } },
    status: { type: DataTypes.ENUM("trialing", "active", "past_due", "cancelled"), allowNull: false },
    starts_at: dt(false), ends_at: dt(), ...ts(),
  });
  await qi.addIndex("subscriptions", ["tenant_id", "status"], { name: "ix_subscriptions_tenant_status" });

  await qi.createTable("tenant_entitlements", {
    id: id(), tenant_id: tenantId(), feature_code: str(60),
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, ...ts(),
  });
  await qi.addIndex("tenant_entitlements", ["tenant_id", "feature_code"], { unique: true, name: "uq_tenant_entitlements" });

  await qi.createTable("tenant_quotas", {
    id: id(), tenant_id: tenantId(), quota_key: str(60),
    limit_value: { type: DataTypes.BIGINT, allowNull: false }, ...ts(),
  });
  await qi.addIndex("tenant_quotas", ["tenant_id", "quota_key"], { unique: true, name: "uq_tenant_quotas" });

  await qi.createTable("usage_meters", {
    id: id(), tenant_id: tenantId(), meter_key: str(60), period: str(10), // e.g. 2026-10
    value: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 }, ...ts(),
  });
  await qi.addIndex("usage_meters", ["tenant_id", "meter_key", "period"], { unique: true, name: "uq_usage_meters" });
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["usage_meters", "tenant_quotas", "tenant_entitlements", "subscriptions", "plan_features", "features", "plans"]) await qi.dropTable(t);
}
