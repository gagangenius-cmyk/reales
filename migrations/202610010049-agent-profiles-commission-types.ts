import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk } from "./_helpers";

/**
 * Internal vs external agents. An internal agent is staff of the brokerage; an external agent is a freelancer or comes from a
 * partner brokerage (co-broke) and is paid per deal. A profile can pin a commission plan; otherwise the newest active plan
 * for the deal type and agent type applies. Calculations keep the VAT on the commission and payout details.
 */
export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("agent_profiles", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false),
    agent_type: { type: DataTypes.ENUM("internal", "external"), allowNull: false, defaultValue: "internal" },
    commission_plan_id: uuid(), brn: str(40, true), agency_name: str(160, true), agency_licence_no: str(60, true), payout_note: str(255, true),
    status: { type: DataTypes.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" }, ...ts(),
  });
  await tenantKey(qi, "agent_profiles");
  await qi.addIndex("agent_profiles", ["tenant_id", "user_id"], { unique: true, name: "uq_agent_profiles_user" });
  await qi.addIndex("agent_profiles", ["tenant_id", "agent_type", "status"], { name: "ix_agent_profiles_type" });
  await tenantFk(sequelize, "agent_profiles", "user_id", "users");
  await tenantFk(sequelize, "agent_profiles", "commission_plan_id", "commission_plans");

  await qi.addColumn("commission_plans", "agent_type", { type: DataTypes.ENUM("any", "internal", "external"), allowNull: false, defaultValue: "any" });
  await qi.addColumn("commission_plans", "vat_pct", { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 5 });
  await qi.addColumn("commission_calculations", "agent_type", { type: DataTypes.ENUM("internal", "external"), allowNull: true });
  await qi.addColumn("commission_calculations", "vat_amount", { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 });
  await qi.addColumn("commission_calculations", "paid_at", dt());
  await qi.addColumn("commission_calculations", "paid_by", str(64, true));
  await qi.addColumn("commission_calculations", "paid_reference", str(120, true));
}

export async function down({ context: qi }: Ctx) {
  for (const c of ["paid_reference", "paid_by", "paid_at", "vat_amount", "agent_type"]) await qi.removeColumn("commission_calculations", c);
  await qi.removeColumn("commission_plans", "vat_pct");
  await qi.removeColumn("commission_plans", "agent_type");
  await qi.dropTable("agent_profiles");
}
