import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk, step } from "./_helpers";

/**
 * Lead pools and automatic repooling, plus a call log.
 *  - a pool holds unassigned leads that any permitted agent can claim (with a daily claim limit);
 *  - repool rules take a lead off an agent who has not responded or worked it in time and send it to the pool, to the next agent, or alert a manager;
 *  - call logs record each call: direction, outcome, duration, notes and the follow-up it creates.
 */
export async function up({ context: qi, sequelize }: Ctx) {
  await step(() => qi.createTable("lead_pools", {
    id: id(), tenant_id: tenantId(), name: str(120), description: str(255, true), branch_id: uuid(),
    daily_claim_limit: { type: DataTypes.INTEGER, allowNull: true }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, ...ts(),
  }));
  await step(() => tenantKey(qi, "lead_pools"));

  await step(() => qi.addColumn("leads", "pool_id", uuid()));
  await step(() => qi.addColumn("leads", "pooled_at", dt()));
  await step(() => qi.addColumn("leads", "repool_count", { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }));
  await step(() => qi.addIndex("leads", ["tenant_id", "pool_id", "status"], { name: "ix_leads_tenant_pool" }));

  await step(() => qi.createTable("repool_rules", {
    id: id(), tenant_id: tenantId(), name: str(120),
    trigger_kind: { type: DataTypes.ENUM("no_first_response", "no_activity"), allowNull: false },
    after_minutes: { type: DataTypes.INTEGER, allowNull: false },
    action: { type: DataTypes.ENUM("reassign", "to_pool", "notify_manager"), allowNull: false },
    pool_id: uuid(), max_repools: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
    hot_only: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, ...ts(),
  }));
  await step(() => tenantKey(qi, "repool_rules"));
  await step(() => tenantFk(sequelize, "repool_rules", "pool_id", "lead_pools"));

  await step(() => qi.createTable("call_logs", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false), lead_id: uuid(), contact_id: uuid(false),
    direction: { type: DataTypes.ENUM("outbound", "inbound"), allowNull: false, defaultValue: "outbound" },
    outcome: { type: DataTypes.ENUM("answered", "no_answer", "busy", "voicemail", "wrong_number", "callback_requested", "not_interested"), allowNull: false },
    started_at: { type: DataTypes.DATE(3), allowNull: false }, duration_sec: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    notes: { type: DataTypes.TEXT, allowNull: true }, follow_up_at: dt(), recording_url: str(500, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "call_logs"));
  await step(() => qi.addIndex("call_logs", ["tenant_id", "user_id", "started_at"], { name: "ix_call_logs_user_day" }));
  await step(() => qi.addIndex("call_logs", ["tenant_id", "lead_id", "started_at"], { name: "ix_call_logs_lead" }));
  await step(() => tenantFk(sequelize, "call_logs", "user_id", "users"));
  await step(() => tenantFk(sequelize, "call_logs", "lead_id", "leads"));
  await step(() => tenantFk(sequelize, "call_logs", "contact_id", "contacts"));
}

export async function down({ context: qi }: Ctx) {
  for (const t of ["call_logs", "repool_rules"]) await qi.dropTable(t);
  await qi.removeIndex("leads", "ix_leads_tenant_pool");
  for (const c of ["repool_count", "pooled_at", "pool_id"]) await qi.removeColumn("leads", c);
  await qi.dropTable("lead_pools");
}
