import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, json, dt, tenantKey, tenantFk, step } from "./_helpers";

/**
 * Google Workspace connection: one OAuth account per user (tokens encrypted, server side only), Calendar push/pull bookkeeping,
 * and Gmail header metadata linked to contacts. Raw tokens never leave the server.
 */
export async function up({ context: qi, sequelize }: Ctx) {
  const flag = (def: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue: def });
  await step(() => qi.createTable("connected_accounts", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false), provider: { type: DataTypes.ENUM("google"), allowNull: false }, external_email: str(254), scopes: json(false),
    status: { type: DataTypes.ENUM("active", "revoked", "error"), allowNull: false, defaultValue: "active" },
    access_token_enc: { type: DataTypes.TEXT, allowNull: true }, refresh_token_enc: { type: DataTypes.TEXT, allowNull: true }, access_expires_at: dt(),
    sync_calendar: flag(true), sync_gmail: flag(false),
    calendar_sync_token: { type: DataTypes.TEXT, allowNull: true }, calendar_dirty: flag(false),
    channel_id: str(64, true), channel_token_hash: str(64, true), channel_expires_at: dt(),
    last_calendar_sync_at: dt(), last_gmail_sync_at: dt(), last_error: str(300, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "connected_accounts"));
  await step(() => qi.addIndex("connected_accounts", ["tenant_id", "user_id", "provider"], { unique: true, name: "uq_connected_account_user" }));
  await step(() => qi.addIndex("connected_accounts", ["channel_id"], { unique: true, name: "uq_connected_account_channel" }));
  await step(() => qi.addIndex("connected_accounts", ["status", "sync_calendar", "sync_gmail"], { name: "ix_connected_account_sync" }));

  await step(() => qi.createTable("calendar_external_events", {
    id: id(), tenant_id: tenantId(), account_id: uuid(false), local_type: { type: DataTypes.ENUM("task", "viewing"), allowNull: true }, local_id: uuid(),
    google_event_id: str(255), content_hash: str(64, true), busy_only: flag(false), starts_at: dt(), ends_at: dt(), ...ts(),
  }));
  await step(() => tenantFk(sequelize, "calendar_external_events", "account_id", "connected_accounts", "CASCADE"));
  await step(() => qi.addIndex("calendar_external_events", ["account_id", "google_event_id"], { unique: true, name: "uq_cal_ext_google" }));
  await step(() => qi.addIndex("calendar_external_events", ["account_id", "local_type", "local_id"], { unique: true, name: "uq_cal_ext_local" }));
  await step(() => qi.addIndex("calendar_external_events", ["tenant_id", "account_id", "starts_at"], { name: "ix_cal_ext_range" }));

  await step(() => qi.createTable("email_external_messages", {
    id: id(), tenant_id: tenantId(), account_id: uuid(false), gmail_message_id: str(64), thread_id: str(64, true), direction: { type: DataTypes.ENUM("in", "out"), allowNull: false },
    contact_id: uuid(), subject: str(300, true), from_address: str(254, true), to_addresses: json(), message_at: { type: DataTypes.DATE(3), allowNull: false }, ...ts(),
  }));
  await step(() => tenantFk(sequelize, "email_external_messages", "account_id", "connected_accounts", "CASCADE"));
  await step(() => qi.addIndex("email_external_messages", ["account_id", "gmail_message_id"], { unique: true, name: "uq_email_ext_message" }));
  await step(() => qi.addIndex("email_external_messages", ["tenant_id", "contact_id", "message_at"], { name: "ix_email_ext_contact" }));
}
export async function down({ context: qi }: Ctx) {
  await qi.dropTable("email_external_messages");
  await qi.dropTable("calendar_external_events");
  await qi.dropTable("connected_accounts");
}
