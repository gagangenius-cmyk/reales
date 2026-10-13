import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt } from "./_helpers";

export async function up({ context: qi }: Ctx) {
  await qi.createTable("users", {
    id: id(), tenant_id: tenantId(),
    email: str(254), normalized_email: str(254), password_hash: str(255, true),
    status: { type: DataTypes.ENUM("active", "invited", "disabled"), allowNull: false, defaultValue: "invited" },
    business_unit_id: uuid(), branch_id: uuid(),
    failed_login_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    locked_until: dt(), last_login_at: dt(), ...ts(),
  });
  await qi.addIndex("users", ["tenant_id", "normalized_email"], { unique: true, name: "uq_users_tenant_email" });
  await qi.addIndex("users", ["tenant_id", "status"], { name: "ix_users_tenant_status" });

  await qi.createTable("user_profiles", {
    user_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
    tenant_id: tenantId(),
    first_name: str(120, true), last_name: str(120, true), phone_e164: str(32, true),
    locale: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "en" },
    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "Asia/Dubai" }, ...ts(),
  });
  await qi.addIndex("user_profiles", ["tenant_id"], { name: "ix_user_profiles_tenant" });

  await qi.createTable("sessions", {
    id: id(), tenant_id: tenantId(),
    user_id: { ...uuid(false), references: { model: "users", key: "id" }, onDelete: "CASCADE" },
    secret_hash: str(64), // sha256 of the opaque session secret; the secret itself is never stored
    user_agent: str(255, true), ip: str(64, true),
    expires_at: dt(false), last_seen_at: dt(false), revoked_at: dt(),
    mfa_verified_at: dt(), step_up_until: dt(), ...ts(),
  });
  await qi.addIndex("sessions", ["tenant_id", "user_id"], { name: "ix_sessions_tenant_user" });
  await qi.addIndex("sessions", ["expires_at"], { name: "ix_sessions_expires" });
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["sessions", "user_profiles", "users"]) await qi.dropTable(t);
}
