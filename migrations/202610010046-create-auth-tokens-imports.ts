import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  // One-time tokens for password reset and invitations. Only the SHA-256 of the token is stored; the token itself exists only in the e-mailed link.
  await qi.createTable("auth_tokens", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false), kind: { type: DataTypes.ENUM("password_reset", "invite"), allowNull: false }, token_hash: str(64),
    expires_at: { type: DataTypes.DATE(3), allowNull: false }, used_at: dt(), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("auth_tokens", ["token_hash"], { unique: true, name: "uq_auth_token_hash" });
  await qi.addIndex("auth_tokens", ["tenant_id", "user_id", "kind", "used_at"], { name: "ix_auth_tokens_user" });
  await tenantFk(sequelize, "auth_tokens", "user_id", "users");

  // Bulk data import: a job is validated first (nothing written), then committed in one go. Rejected rows are kept for download.
  await qi.createTable("import_jobs", {
    id: id(), tenant_id: tenantId(), kind: { type: DataTypes.ENUM("contacts", "leads", "units"), allowNull: false }, filename: str(255), created_by: uuid(false),
    status: { type: DataTypes.ENUM("validated", "committed", "failed", "cancelled"), allowNull: false, defaultValue: "validated" },
    total_rows: { type: DataTypes.INTEGER, allowNull: false }, valid_rows: { type: DataTypes.INTEGER, allowNull: false }, error_rows: { type: DataTypes.INTEGER, allowNull: false },
    committed_rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, skipped_rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    payload: json(), errors: json(), options: json(), ...ts(),
  });
  await tenantKey(qi, "import_jobs");
  await qi.addIndex("import_jobs", ["tenant_id", "created_at"], { name: "ix_import_jobs" });
  await tenantFk(sequelize, "import_jobs", "created_by", "users");
}

export async function down({ context: qi }: Ctx) {
  await qi.dropTable("import_jobs");
  await qi.dropTable("auth_tokens");
}
