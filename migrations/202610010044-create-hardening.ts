import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  // SSO (OpenID Connect, authorization-code + PKCE). The client secret is stored encrypted; the IdP is trusted only for the configured email domains.
  await qi.createTable("sso_connections", {
    id: id(), tenant_id: tenantId(), name: str(120), protocol: { type: DataTypes.ENUM("oidc"), allowNull: false, defaultValue: "oidc" }, issuer: str(255), client_id: str(255), client_secret_enc: { type: DataTypes.TEXT, allowNull: true },
    authorization_endpoint: str(500), token_endpoint: str(500), jwks_uri: str(500), email_domains: json(false),
    jit_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, jit_role_key: str(60, true), trust_idp_mfa: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    enforce: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, status: { type: DataTypes.ENUM("active", "disabled"), allowNull: false, defaultValue: "active" }, ...ts(),
  });
  await tenantKey(qi, "sso_connections");
  await qi.addIndex("sso_connections", ["tenant_id", "name"], { unique: true, name: "uq_sso_name" });

  await qi.createTable("sso_states", {
    id: id(), tenant_id: tenantId(), connection_id: uuid(false), state_hash: str(64), nonce: str(64), code_verifier_enc: { type: DataTypes.TEXT, allowNull: false }, redirect_uri: str(500),
    login_hint: str(254, true), expires_at: { type: DataTypes.DATE(3), allowNull: false }, used_at: dt(), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("sso_states", ["state_hash"], { unique: true, name: "uq_sso_state" });
  await tenantFk(sequelize, "sso_states", "connection_id", "sso_connections");

  // Data-processing policy and sub-processor register. Provider calls are checked against these before leaving the platform.
  await qi.createTable("data_processing_policies", {
    id: id(), tenant_id: tenantId(), allowed_regions: json(false), allow_cross_border: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    require_registered_providers: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, updated_by: str(64, true), ...ts(),
  });
  await qi.addIndex("data_processing_policies", ["tenant_id"], { unique: true, name: "uq_dpp_tenant" });

  await qi.createTable("subprocessors", {
    id: id(), tenant_id: tenantId(), code: str(60), name: str(160), purpose: str(255), region: str(32), status: { type: DataTypes.ENUM("approved", "pending", "blocked"), allowNull: false, defaultValue: "pending" },
    dpa_signed_on: { type: DataTypes.DATEONLY, allowNull: true }, ...ts(),
  });
  await qi.addIndex("subprocessors", ["tenant_id", "code"], { unique: true, name: "uq_subprocessor_code" });

  // Mobile: registered devices and the server-side mutation journal (client mutation ids make replays no-ops).
  await qi.createTable("mobile_devices", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false), device_id: str(80), name: str(120, true), platform: { type: DataTypes.ENUM("ios", "android", "web"), allowNull: false },
    status: { type: DataTypes.ENUM("active", "revoked"), allowNull: false, defaultValue: "active" }, last_sync_at: dt(), revoked_at: dt(), ...ts(),
  });
  await tenantKey(qi, "mobile_devices");
  await qi.addIndex("mobile_devices", ["tenant_id", "device_id"], { unique: true, name: "uq_mobile_device" });
  await tenantFk(sequelize, "mobile_devices", "user_id", "users");

  await qi.createTable("mobile_mutations", {
    id: id(), tenant_id: tenantId(), device_id: uuid(false), client_mutation_id: str(80), kind: str(60), status: { type: DataTypes.ENUM("applied", "conflict", "rejected"), allowNull: false },
    result: json(), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("mobile_mutations", ["tenant_id", "device_id", "client_mutation_id"], { unique: true, name: "uq_mobile_mutation" });
  await tenantFk(sequelize, "mobile_mutations", "device_id", "mobile_devices");
}

export async function down({ context: qi }: Ctx) {
  for (const t of ["mobile_mutations", "mobile_devices", "subprocessors", "data_processing_policies", "sso_states", "sso_connections"]) await qi.dropTable(t);
}
