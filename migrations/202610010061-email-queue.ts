import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, step } from "./_helpers";

/**
 * Notification e-mails wait here and are sent by the scheduler (with retries), so a business action never fails or slows down because the mail server is
 * down. dedupe_key makes a re-run of a sweep harmless: the same reminder is never queued twice.
 */
export async function up({ context: qi }: Ctx) {
  await step(() => qi.createTable("email_queue", {
    id: id(), tenant_id: tenantId(), user_id: uuid(), to_email: str(254), kind: str(60), subject: str(300), body: { type: DataTypes.TEXT, allowNull: false },
    dedupe_key: str(160, true), status: { type: DataTypes.ENUM("queued", "sent", "failed"), allowNull: false, defaultValue: "queued" }, attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_error: str(300, true), send_after: dt(false), sent_at: dt(), ...ts(),
  }));
  await step(() => tenantKey(qi, "email_queue"));
  await step(() => qi.addIndex("email_queue", ["tenant_id", "dedupe_key"], { unique: true, name: "uq_email_queue_dedupe" }));
  await step(() => qi.addIndex("email_queue", ["status", "send_after"], { name: "ix_email_queue_due" }));
}

export async function down({ context: qi }: Ctx) {
  await qi.dropTable("email_queue");
}
