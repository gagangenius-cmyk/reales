import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("channel_accounts", {
    id: id(), tenant_id: tenantId(), channel: { type: DataTypes.ENUM("email", "whatsapp", "sms"), allowNull: false },
    provider: str(40), name: str(120), identity: str(254), // from-address or sending number
    config: json(), // non-secret settings; credentials live in the secrets manager
    status: { type: DataTypes.ENUM("active", "disabled"), allowNull: false, defaultValue: "active" }, ...ts(),
  });
  await tenantKey(qi, "channel_accounts");
  await qi.addIndex("channel_accounts", ["tenant_id", "channel", "status"], { name: "ix_channel_accounts" });

  await qi.createTable("conversations", {
    id: id(), tenant_id: tenantId(), contact_id: uuid(false), channel: { type: DataTypes.ENUM("email", "whatsapp", "sms"), allowNull: false },
    channel_account_id: uuid(), lead_id: uuid(), assigned_user_id: uuid(), branch_id: uuid(),
    status: { type: DataTypes.ENUM("open", "closed"), allowNull: false, defaultValue: "open" },
    last_message_at: dt(), last_inbound_at: dt(), unread_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, ...ts(),
  });
  await tenantKey(qi, "conversations");
  await qi.addIndex("conversations", ["tenant_id", "contact_id", "channel"], { unique: true, name: "uq_conversation_contact_channel" });
  await qi.addIndex("conversations", ["tenant_id", "assigned_user_id", "status", "last_message_at"], { name: "ix_conversations_inbox" });
  await tenantFk(sequelize, "conversations", "contact_id", "contacts");
  await tenantFk(sequelize, "conversations", "channel_account_id", "channel_accounts");
  await tenantFk(sequelize, "conversations", "lead_id", "leads");
  await tenantFk(sequelize, "conversations", "assigned_user_id", "users");
  await tenantFk(sequelize, "conversations", "branch_id", "branches");

  await qi.createTable("messages", {
    id: id(), tenant_id: tenantId(), conversation_id: uuid(false), direction: { type: DataTypes.ENUM("inbound", "outbound"), allowNull: false },
    channel: { type: DataTypes.ENUM("email", "whatsapp", "sms"), allowNull: false },
    status: { type: DataTypes.ENUM("queued", "sent", "delivered", "read", "failed", "received"), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false }, subject: str(255, true), template_version_id: uuid(), campaign_id: uuid(), workflow_run_id: uuid(),
    provider: str(40, true), provider_message_id: str(160, true), idempotency_key: str(200, true), error: str(500, true),
    sender_user_id: uuid(), occurred_at: { type: DataTypes.DATE(3), allowNull: false }, ...ts(),
  });
  await tenantKey(qi, "messages");
  await qi.addIndex("messages", ["tenant_id", "conversation_id", "occurred_at"], { name: "ix_messages_conversation" });
  await qi.addIndex("messages", ["tenant_id", "idempotency_key"], { unique: true, name: "uq_messages_idempotency" });
  await qi.addIndex("messages", ["tenant_id", "provider", "provider_message_id"], { unique: true, name: "uq_messages_provider_ref" });
  await tenantFk(sequelize, "messages", "conversation_id", "conversations");
  await tenantFk(sequelize, "messages", "template_version_id", "template_versions");
  await tenantFk(sequelize, "messages", "sender_user_id", "users");

  // Raw provider delivery/read callbacks are kept separately from the message projection.
  await qi.createTable("message_events", {
    id: id(), tenant_id: tenantId(), message_id: uuid(false), type: str(30), provider_event_id: str(160, true), payload: json(),
    created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("message_events", ["tenant_id", "message_id", "created_at"], { name: "ix_message_events" });
  await tenantFk(sequelize, "message_events", "message_id", "messages");
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["message_events", "messages", "conversations", "channel_accounts"]) await qi.dropTable(t);
}
