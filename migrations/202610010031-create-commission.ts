import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  const money = (allowNull = false) => ({ type: DataTypes.DECIMAL(18, 2), allowNull });
  await qi.createTable("commission_plans", {
    id: id(), tenant_id: tenantId(), name: str(120), deal_type: { type: DataTypes.ENUM("sale", "lease"), allowNull: false },
    rate_pct: { type: DataTypes.DECIMAL(6, 3), allowNull: false }, splits: json(false), // [{ role, pct }] summing to 100
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, ...ts(),
  });
  await tenantKey(qi, "commission_plans");
  await qi.addIndex("commission_plans", ["tenant_id", "deal_type", "active"], { name: "ix_commission_plans_type" });

  await qi.createTable("commission_calculations", {
    id: id(), tenant_id: tenantId(), deal_id: uuid(false), plan_id: uuid(false), agent_user_id: uuid(), branch_id: uuid(), gross_amount: money(), commission_amount: money(), currency: { type: DataTypes.STRING(3), allowNull: false },
    status: { type: DataTypes.ENUM("calculated", "approved", "void"), allowNull: false, defaultValue: "calculated" },
    approved_by: str(64, true), approved_at: dt(), calculated_at: { type: DataTypes.DATE(3), allowNull: false }, ...ts(),
  });
  await tenantKey(qi, "commission_calculations");
  await qi.addIndex("commission_calculations", ["tenant_id", "deal_id", "status"], { name: "ix_commission_calc_deal" });
  await tenantFk(sequelize, "commission_calculations", "deal_id", "deals");
  await tenantFk(sequelize, "commission_calculations", "plan_id", "commission_plans");
  await tenantFk(sequelize, "commission_calculations", "agent_user_id", "users");
  await tenantFk(sequelize, "commission_calculations", "branch_id", "branches");
  // At most one non-void calculation per deal.
  await sequelize.query("ALTER TABLE commission_calculations ADD COLUMN live_deal_id CHAR(36) GENERATED ALWAYS AS (IF(status <> 'void', deal_id, NULL)) STORED");
  await sequelize.query("ALTER TABLE commission_calculations ADD UNIQUE INDEX uq_commission_live_deal (tenant_id, live_deal_id)");

  await qi.createTable("commission_splits", {
    id: id(), tenant_id: tenantId(), calculation_id: uuid(false), role: str(40), user_id: uuid(), pct: { type: DataTypes.DECIMAL(6, 3), allowNull: false }, amount: money(), ...ts(),
  });
  await qi.addIndex("commission_splits", ["tenant_id", "calculation_id"], { name: "ix_commission_splits_calc" });
  await qi.addIndex("commission_splits", ["tenant_id", "user_id"], { name: "ix_commission_splits_user" });
  await tenantFk(sequelize, "commission_splits", "calculation_id", "commission_calculations", "CASCADE");
  await tenantFk(sequelize, "commission_splits", "user_id", "users");
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["commission_splits", "commission_calculations", "commission_plans"]) await qi.dropTable(t);
}
