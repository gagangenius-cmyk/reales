import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk } from "./_helpers";

/**
 * When an agent can take viewings. Weekly windows are wall-clock times in the workspace time zone (UAE: Asia/Dubai, UTC+4, no DST);
 * time off blocks specific periods. An agent with no windows is unrestricted, so existing bookings keep working.
 */
export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("agent_availability", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false),
    weekday: { type: DataTypes.TINYINT, allowNull: false }, // 0 = Sunday ... 6 = Saturday
    start_time: str(5), end_time: str(5), // "HH:mm"
    ...ts(),
  });
  await tenantKey(qi, "agent_availability");
  await qi.addIndex("agent_availability", ["tenant_id", "user_id", "weekday"], { name: "ix_agent_availability_user_day" });
  await tenantFk(sequelize, "agent_availability", "user_id", "users", "CASCADE");

  await qi.createTable("agent_time_off", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false), starts_at: { type: DataTypes.DATE(3), allowNull: false }, ends_at: { type: DataTypes.DATE(3), allowNull: false },
    reason: str(160, true), created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "agent_time_off");
  await qi.addIndex("agent_time_off", ["tenant_id", "user_id", "starts_at"], { name: "ix_agent_time_off_user" });
  await tenantFk(sequelize, "agent_time_off", "user_id", "users", "CASCADE");
}

export async function down({ context: qi }: Ctx) {
  await qi.dropTable("agent_time_off");
  await qi.dropTable("agent_availability");
}
