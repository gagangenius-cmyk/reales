import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("segments", {
    id: id(), tenant_id: tenantId(), name: str(160), definition: json(false), // declarative filter, never raw SQL
    created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "segments");
  await qi.addIndex("segments", ["tenant_id", "name"], { unique: true, name: "uq_segments_name" });

  await qi.createTable("campaigns", {
    id: id(), tenant_id: tenantId(), name: str(160), channel: { type: DataTypes.ENUM("email", "whatsapp", "sms"), allowNull: false },
    template_version_id: uuid(false), segment_id: uuid(), channel_account_id: uuid(false), purpose_code: str(60),
    status: { type: DataTypes.ENUM("draft", "scheduled", "preparing", "running", "paused", "completed", "failed", "cancelled"), allowNull: false, defaultValue: "draft" },
    scheduled_at: dt(), started_at: dt(), completed_at: dt(), max_per_minute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    totals: json(), created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "campaigns");
  await qi.addIndex("campaigns", ["tenant_id", "status", "scheduled_at"], { name: "ix_campaigns_status_schedule" });
  await tenantFk(sequelize, "campaigns", "template_version_id", "template_versions");
  await tenantFk(sequelize, "campaigns", "segment_id", "segments");
  await tenantFk(sequelize, "campaigns", "channel_account_id", "channel_accounts");
  await tenantFk(sequelize, "messages", "campaign_id", "campaigns");

  // The audience is SNAPSHOTTED at prepare time: contacts moving in/out of the segment mid-broadcast never change who is sent to.
  await qi.createTable("campaign_recipients", {
    id: id(), tenant_id: tenantId(), campaign_id: uuid(false), contact_id: uuid(false), destination: str(254),
    channel: { type: DataTypes.ENUM("email", "whatsapp", "sms"), allowNull: false },
    status: { type: DataTypes.ENUM("pending", "sending", "sent", "delivered", "read", "replied", "failed", "skipped"), allowNull: false, defaultValue: "pending" },
    skip_reason: str(60, true), message_id: uuid(), attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, last_error: str(500, true),
    sent_at: dt(), ...ts(),
  });
  await tenantKey(qi, "campaign_recipients");
  await qi.addIndex("campaign_recipients", ["tenant_id", "campaign_id", "contact_id", "destination", "channel"], { unique: true, name: "uq_campaign_recipient" });
  await qi.addIndex("campaign_recipients", ["tenant_id", "campaign_id", "status"], { name: "ix_campaign_recipients_status" });
  await tenantFk(sequelize, "campaign_recipients", "campaign_id", "campaigns");
  await tenantFk(sequelize, "campaign_recipients", "contact_id", "contacts");
  await tenantFk(sequelize, "campaign_recipients", "message_id", "messages");

  await qi.createTable("campaign_events", {
    id: id(), tenant_id: tenantId(), campaign_id: uuid(false), type: str(40), detail: json(), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("campaign_events", ["tenant_id", "campaign_id", "created_at"], { name: "ix_campaign_events" });
  await tenantFk(sequelize, "campaign_events", "campaign_id", "campaigns");
}
export async function down({ context: qi, sequelize }: Ctx) {
  await sequelize.query("ALTER TABLE messages DROP FOREIGN KEY fk_messages_campaign_id");
  for (const t of ["campaign_events", "campaign_recipients", "campaigns", "segments"]) await qi.dropTable(t);
}
