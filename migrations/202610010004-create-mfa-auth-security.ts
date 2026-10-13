import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json } from "./_helpers";

export async function up({ context: qi }: Ctx) {
  await qi.createTable("mfa_methods", {
    id: id(), tenant_id: tenantId(),
    user_id: { ...uuid(false), references: { model: "users", key: "id" }, onDelete: "CASCADE" },
    type: { type: DataTypes.ENUM("totp"), allowNull: false, defaultValue: "totp" },
    secret_encrypted: { type: DataTypes.TEXT, allowNull: false }, // AES-256-GCM envelope
    verified_at: dt(), last_used_step: { type: DataTypes.BIGINT, allowNull: true }, // TOTP replay protection
    recovery_codes_hash: json(), ...ts(),
  });
  await qi.addIndex("mfa_methods", ["tenant_id", "user_id"], { name: "ix_mfa_tenant_user" });

  await qi.createTable("login_events", {
    id: id(), tenant_id: { ...uuid(true), references: { model: "tenants", key: "id" } },
    user_id: uuid(), email: str(254, true),
    outcome: { type: DataTypes.ENUM("success", "bad_password", "unknown_user", "locked", "mfa_required", "mfa_failed", "disabled"), allowNull: false },
    ip: str(64, true), user_agent: str(255, true),
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("login_events", ["tenant_id", "created_at"], { name: "ix_login_events_tenant_time" });

  await qi.createTable("security_events", {
    id: id(), tenant_id: tenantId(), user_id: uuid(), type: str(60), details: json(),
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("security_events", ["tenant_id", "type", "created_at"], { name: "ix_security_events_tenant_type" });
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["security_events", "login_events", "mfa_methods"]) await qi.dropTable(t);
}
