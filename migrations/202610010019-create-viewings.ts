import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("viewings", {
    id: id(), tenant_id: tenantId(), lead_id: uuid(), contact_id: uuid(false), unit_id: uuid(), listing_id: uuid(),
    agent_user_id: uuid(false), branch_id: uuid(), project_id: uuid(),
    scheduled_at: { type: DataTypes.DATE(3), allowNull: false }, duration_min: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
    status: { type: DataTypes.ENUM("scheduled", "checked_in", "completed", "cancelled", "no_show"), allowNull: false, defaultValue: "scheduled" },
    location_note: str(255, true), checked_in_at: dt(), completed_at: dt(), cancelled_reason: str(255, true), created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "viewings");
  await qi.addIndex("viewings", ["tenant_id", "agent_user_id", "scheduled_at"], { name: "ix_viewings_agent_time" });
  await qi.addIndex("viewings", ["tenant_id", "status", "scheduled_at"], { name: "ix_viewings_status_time" });
  await qi.addIndex("viewings", ["tenant_id", "lead_id"], { name: "ix_viewings_lead" });
  await tenantFk(sequelize, "viewings", "lead_id", "leads");
  await tenantFk(sequelize, "viewings", "contact_id", "contacts");
  await tenantFk(sequelize, "viewings", "unit_id", "units");
  await tenantFk(sequelize, "viewings", "listing_id", "listings");
  await tenantFk(sequelize, "viewings", "agent_user_id", "users");
  await tenantFk(sequelize, "viewings", "branch_id", "branches");
  await tenantFk(sequelize, "viewings", "project_id", "projects");

  await qi.createTable("viewing_feedback", {
    id: id(), tenant_id: tenantId(), viewing_id: uuid(false), rating: { type: DataTypes.INTEGER, allowNull: false },
    interest: { type: DataTypes.ENUM("high", "medium", "low", "none"), allowNull: false }, notes: { type: DataTypes.TEXT, allowNull: true },
    created_by: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("viewing_feedback", ["tenant_id", "viewing_id"], { unique: true, name: "uq_viewing_feedback" });
  await tenantFk(sequelize, "viewing_feedback", "viewing_id", "viewings");
}
export async function down({ context: qi }: Ctx) {
  await qi.dropTable("viewing_feedback");
  await qi.dropTable("viewings");
}
