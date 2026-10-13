import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("activities", {
    id: id(), tenant_id: tenantId(), entity_type: str(40), entity_id: uuid(false),
    kind: { type: DataTypes.ENUM("note", "call", "whatsapp", "email", "sms", "viewing", "system"), allowNull: false },
    summary: { type: DataTypes.TEXT, allowNull: false }, actor_id: str(64, true),
    occurred_at: { type: DataTypes.DATE(3), allowNull: false }, created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("activities", ["tenant_id", "entity_type", "entity_id", "occurred_at"], { name: "ix_activities_entity" });

  await qi.createTable("tasks", {
    id: id(), tenant_id: tenantId(), title: str(255), lead_id: uuid(), assignee_id: uuid(), due_at: dt(),
    status: { type: DataTypes.ENUM("open", "done", "cancelled"), allowNull: false, defaultValue: "open" }, completed_at: dt(), ...ts(),
  });
  await tenantKey(qi, "tasks");
  await qi.addIndex("tasks", ["tenant_id", "assignee_id", "status", "due_at"], { name: "ix_tasks_assignee" });
  await tenantFk(sequelize, "tasks", "lead_id", "leads");
  await tenantFk(sequelize, "tasks", "assignee_id", "users");
}
export async function down({ context: qi }: Ctx) {
  await qi.dropTable("tasks");
  await qi.dropTable("activities");
}
