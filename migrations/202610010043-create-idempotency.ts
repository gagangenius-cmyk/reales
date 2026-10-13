import { DataTypes } from "sequelize";
import { Ctx, id, str, tenantId, dt, json } from "./_helpers";

export async function up({ context: qi }: Ctx) {
  await qi.createTable("idempotency_keys", {
    id: id(), tenant_id: tenantId(), scope: str(120), key: str(200), request_hash: str(64),
    status: { type: DataTypes.ENUM("in_progress", "completed"), allowNull: false },
    response_status: { type: DataTypes.INTEGER, allowNull: true }, response_body: json(),
    expires_at: dt(false),
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("idempotency_keys", ["tenant_id", "scope", "key"], { unique: true, name: "uq_idempotency" });
  await qi.addIndex("idempotency_keys", ["expires_at"], { name: "ix_idempotency_expires" });
}
export async function down({ context: qi }: Ctx) { await qi.dropTable("idempotency_keys"); }
