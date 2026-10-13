import { DataTypes } from "sequelize";
import { Ctx, id, str, tenantId, uuid, dt, json } from "./_helpers";

export async function up({ context: qi }: Ctx) {
  await qi.createTable("outbox_events", {
    id: id(), tenant_id: tenantId(),
    type: str(100), version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    project_id: uuid(), aggregate_type: str(60), aggregate_id: str(64),
    actor_id: str(64, true), correlation_id: str(80), causation_id: str(80, true),
    payload: json(false),
    occurred_at: { type: DataTypes.DATE(3), allowNull: false },
    status: { type: DataTypes.ENUM("pending", "dispatched", "failed"), allowNull: false, defaultValue: "pending" },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    next_attempt_at: { type: DataTypes.DATE(3), allowNull: false },
    dispatched_at: dt(), last_error: { type: DataTypes.TEXT, allowNull: true },
  });
  await qi.addIndex("outbox_events", ["status", "next_attempt_at"], { name: "ix_outbox_dispatch" });
  await qi.addIndex("outbox_events", ["tenant_id", "type", "occurred_at"], { name: "ix_outbox_tenant_type" });
}
export async function down({ context: qi }: Ctx) { await qi.dropTable("outbox_events"); }
