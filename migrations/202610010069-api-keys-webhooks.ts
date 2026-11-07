import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, json, dt, tenantKey, step } from "./_helpers";

/** Machine access: hashed API keys limited to a subset of permissions, and signed outbound webhooks with a delivery queue. */
export async function up({ context: qi }: Ctx) {
  await step(() => qi.createTable("api_keys", {
    id: id(), tenant_id: tenantId(), name: str(120), key_prefix: str(16), key_hash: str(64), scopes: json(false), created_by: uuid(false),
    expires_at: dt(), last_used_at: dt(), revoked_at: dt(), revoked_by: uuid(), ...ts(),
  }));
  await step(() => tenantKey(qi, "api_keys"));
  await step(() => qi.addIndex("api_keys", ["key_prefix"], { unique: true, name: "uq_api_keys_prefix" }));

  await step(() => qi.createTable("webhook_endpoints", {
    id: id(), tenant_id: tenantId(), name: str(120), url: str(500), secret_enc: { type: DataTypes.TEXT, allowNull: false }, event_types: json(false),
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, consecutive_failures: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    disabled_reason: str(255, true), created_by: uuid(false), ...ts(),
  }));
  await step(() => tenantKey(qi, "webhook_endpoints"));

  await step(() => qi.createTable("webhook_deliveries", {
    id: id(), tenant_id: tenantId(), endpoint_id: uuid(false), event_id: uuid(false), event_type: str(80), payload: json(false),
    status: { type: DataTypes.ENUM("pending", "delivered", "failed"), allowNull: false, defaultValue: "pending" },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, next_attempt_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    response_status: { type: DataTypes.INTEGER, allowNull: true }, last_error: str(500, true), delivered_at: dt(), ...ts(),
  }));
  await step(() => qi.addIndex("webhook_deliveries", ["endpoint_id", "event_id"], { unique: true, name: "uq_webhook_delivery_event" }));
  await step(() => qi.addIndex("webhook_deliveries", ["status", "next_attempt_at"], { name: "ix_webhook_delivery_due" }));
  await step(() => qi.addIndex("webhook_deliveries", ["tenant_id", "endpoint_id", "created_at"], { name: "ix_webhook_delivery_endpoint" }));
}
export async function down({ context: qi }: Ctx) {
  await qi.dropTable("webhook_deliveries");
  await qi.dropTable("webhook_endpoints");
  await qi.dropTable("api_keys");
}
