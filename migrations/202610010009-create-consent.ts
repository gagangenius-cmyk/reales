import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk } from "./_helpers";

const CHANNELS = ["whatsapp", "sms", "email", "call"];

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("consent_purposes", {
    id: id(), tenant_id: tenantId(), code: str(60), name: str(120), description: str(500, true),
    default_basis: { type: DataTypes.ENUM("consent", "contract", "legitimate_interest", "legal_obligation"), allowNull: false, defaultValue: "consent" }, ...ts(),
  });
  await tenantKey(qi, "consent_purposes");
  await qi.addIndex("consent_purposes", ["tenant_id", "code"], { unique: true, name: "uq_consent_purposes_code" });

  // Current state per (contact, purpose, channel); the immutable history lives in consent_events.
  await qi.createTable("consent_records", {
    id: id(), tenant_id: tenantId(), contact_id: uuid(false), purpose_id: uuid(false),
    channel: { type: DataTypes.ENUM(...CHANNELS), allowNull: false },
    status: { type: DataTypes.ENUM("granted", "revoked"), allowNull: false },
    basis: str(40), text_version: str(60, true), source: str(80, true), granted_at: dt(), revoked_at: dt(), ...ts(),
  });
  await tenantKey(qi, "consent_records");
  await qi.addIndex("consent_records", ["tenant_id", "contact_id", "purpose_id", "channel"], { unique: true, name: "uq_consent_records" });
  await tenantFk(sequelize, "consent_records", "contact_id", "contacts");
  await tenantFk(sequelize, "consent_records", "purpose_id", "consent_purposes");

  await qi.createTable("consent_events", {
    id: id(), tenant_id: tenantId(), consent_record_id: uuid(false), contact_id: uuid(false), purpose_id: uuid(false),
    channel: { type: DataTypes.ENUM(...CHANNELS), allowNull: false },
    event: { type: DataTypes.ENUM("granted", "revoked"), allowNull: false },
    basis: str(40), text_version: str(60, true), text_hash: str(64, true), source: str(80, true),
    ip: str(64, true), user_agent: str(255, true), actor_id: str(64, true),
    created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("consent_events", ["tenant_id", "contact_id", "created_at"], { name: "ix_consent_events_contact" });
  await tenantFk(sequelize, "consent_events", "consent_record_id", "consent_records");
  await sequelize.query("CREATE TRIGGER consent_events_no_update BEFORE UPDATE ON consent_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consent_events is append-only'");
  await sequelize.query("CREATE TRIGGER consent_events_no_delete BEFORE DELETE ON consent_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consent_events is append-only'");

  await qi.createTable("suppression_entries", {
    id: id(), tenant_id: tenantId(),
    channel: { type: DataTypes.ENUM(...CHANNELS), allowNull: false },
    destination: str(254), // normalised phone (E.164) or lowercase email
    reason: { type: DataTypes.ENUM("unsubscribed", "complaint", "dnd", "bounced", "manual", "legal"), allowNull: false },
    contact_id: uuid(), created_by: str(64, true), ...ts(),
  });
  await qi.addIndex("suppression_entries", ["tenant_id", "channel", "destination"], { unique: true, name: "uq_suppression" });
}
export async function down({ context: qi, sequelize }: Ctx) {
  await sequelize.query("DROP TRIGGER IF EXISTS consent_events_no_update");
  await sequelize.query("DROP TRIGGER IF EXISTS consent_events_no_delete");
  for (const t of ["suppression_entries", "consent_events", "consent_records", "consent_purposes"]) await qi.dropTable(t);
}
