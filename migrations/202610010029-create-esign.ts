import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

async function appendOnly(sequelize: any, table: string) {
  await sequelize.query(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
  await sequelize.query(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
}
async function dropAppendOnly(sequelize: any, table: string) {
  await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_no_update`);
  await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_no_delete`);
}

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("signature_envelopes", {
    id: id(), tenant_id: tenantId(), document_id: uuid(false), document_version: { type: DataTypes.INTEGER, allowNull: false }, content_hash: str(64),
    provider: str(40), provider_envelope_id: str(120, true), deal_id: uuid(),
    status: { type: DataTypes.ENUM("draft", "sent", "completed", "declined", "cancelled", "expired"), allowNull: false, defaultValue: "draft" },
    sent_at: dt(), completed_at: dt(), evidence: json(), created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "signature_envelopes");
  await qi.addIndex("signature_envelopes", ["tenant_id", "status"], { name: "ix_envelopes_status" });
  await qi.addIndex("signature_envelopes", ["tenant_id", "provider", "provider_envelope_id"], { unique: true, name: "uq_envelopes_provider_ref" });
  await qi.addIndex("signature_envelopes", ["provider", "provider_envelope_id"], { name: "ix_envelopes_provider_ref" });
  await tenantFk(sequelize, "signature_envelopes", "document_id", "documents");
  await tenantFk(sequelize, "signature_envelopes", "deal_id", "deals");

  await qi.createTable("signature_signers", {
    id: id(), tenant_id: tenantId(), envelope_id: uuid(false), contact_id: uuid(), name: str(180), email: str(254), sign_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    status: { type: DataTypes.ENUM("pending", "viewed", "signed", "declined"), allowNull: false, defaultValue: "pending" },
    signed_at: dt(), signer_ip: str(64, true), certificate: json(), ...ts(),
  });
  await qi.addIndex("signature_signers", ["tenant_id", "envelope_id"], { name: "ix_signers_envelope" });
  await tenantFk(sequelize, "signature_signers", "envelope_id", "signature_envelopes", "CASCADE");
  await tenantFk(sequelize, "signature_signers", "contact_id", "contacts");

  await qi.createTable("signature_events", {
    id: id(), tenant_id: tenantId(), envelope_id: uuid(false), type: str(60), payload: json(), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("signature_events", ["tenant_id", "envelope_id", "created_at"], { name: "ix_signature_events" });
  await tenantFk(sequelize, "signature_events", "envelope_id", "signature_envelopes");
  await appendOnly(sequelize, "signature_events");
}
export async function down({ context: qi, sequelize }: Ctx) {
  await dropAppendOnly(sequelize, "signature_events");
  for (const t of ["signature_events", "signature_signers", "signature_envelopes"]) await qi.dropTable(t);
}
