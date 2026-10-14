import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

async function appendOnly(sequelize: any, table: string) {
  await sequelize.query(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
  await sequelize.query(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
}

export async function up({ context: qi, sequelize }: Ctx) {
  // One KYC/KYB profile per contact. Identity numbers and dates of birth are stored encrypted (AES-256-GCM), never in clear text.
  await qi.createTable("kyc_profiles", {
    id: id(), tenant_id: tenantId(), contact_id: uuid(false), subject_type: { type: DataTypes.ENUM("individual", "entity"), allowNull: false },
    status: { type: DataTypes.ENUM("draft", "in_review", "approved", "rejected", "expired"), allowNull: false, defaultValue: "draft" },
    risk_level: { type: DataTypes.ENUM("low", "medium", "high", "unrated"), allowNull: false, defaultValue: "unrated" }, risk_score: { type: DataTypes.INTEGER, allowNull: true },
    risk_factors: json(), is_pep: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, nationality: str(60, true), country_of_residence: str(60, true),
    id_type: str(40, true), id_number_enc: { type: DataTypes.TEXT, allowNull: true }, id_number_last4: str(4, true), date_of_birth_enc: { type: DataTypes.TEXT, allowNull: true },
    source_of_funds: str(500, true), occupation: str(160, true), expires_at: { type: DataTypes.DATEONLY, allowNull: true },
    submitted_at: dt(), submitted_by: str(64, true), reviewed_by: str(64, true), reviewed_at: dt(), decision_reason: str(500, true), ...ts(),
  });
  await tenantKey(qi, "kyc_profiles");
  await qi.addIndex("kyc_profiles", ["tenant_id", "contact_id"], { unique: true, name: "uq_kyc_contact" });
  await qi.addIndex("kyc_profiles", ["tenant_id", "status", "risk_level"], { name: "ix_kyc_status" });
  await tenantFk(sequelize, "kyc_profiles", "contact_id", "contacts");

  await qi.createTable("kyc_documents", {
    id: id(), tenant_id: tenantId(), profile_id: uuid(false), document_id: uuid(false), doc_type: { type: DataTypes.ENUM("passport", "emirates_id", "visa", "trade_licence", "proof_of_address", "source_of_funds", "other"), allowNull: false },
    expires_on: { type: DataTypes.DATEONLY, allowNull: true }, ...ts(),
  });
  await qi.addIndex("kyc_documents", ["tenant_id", "profile_id"], { name: "ix_kyc_documents" });
  await tenantFk(sequelize, "kyc_documents", "profile_id", "kyc_profiles");
  await tenantFk(sequelize, "kyc_documents", "document_id", "documents");

  // Beneficial-ownership graph: owner_contact holds pct of parent_contact (an entity). Owners may themselves be entities.
  await qi.createTable("ubo_links", {
    id: id(), tenant_id: tenantId(), parent_contact_id: uuid(false), owner_contact_id: uuid(false), ownership_pct: { type: DataTypes.DECIMAL(6, 3), allowNull: false },
    relation: { type: DataTypes.ENUM("shareholder", "director", "controller", "trustee"), allowNull: false, defaultValue: "shareholder" }, ...ts(),
  });
  await qi.addIndex("ubo_links", ["tenant_id", "parent_contact_id", "owner_contact_id", "relation"], { unique: true, name: "uq_ubo_link" });
  await qi.addIndex("ubo_links", ["tenant_id", "owner_contact_id"], { name: "ix_ubo_owner" });
  await tenantFk(sequelize, "ubo_links", "parent_contact_id", "contacts");
  await tenantFk(sequelize, "ubo_links", "owner_contact_id", "contacts");

  await qi.createTable("screening_runs", {
    id: id(), tenant_id: tenantId(), profile_id: uuid(false), provider: str(40), status: { type: DataTypes.ENUM("completed", "failed"), allowNull: false },
    hit_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, subjects: json(), triggered_by: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("screening_runs", ["tenant_id", "profile_id", "created_at"], { name: "ix_screening_runs" });
  await tenantFk(sequelize, "screening_runs", "profile_id", "kyc_profiles");
  await tenantKey(qi, "screening_runs");

  // A hit is only ever closed by a human disposition with a written reason. Automation can open hits, never clear them.
  await qi.createTable("screening_hits", {
    id: id(), tenant_id: tenantId(), run_id: uuid(false), profile_id: uuid(false), subject_contact_id: uuid(false), list_name: str(80), matched_name: str(200), score: { type: DataTypes.INTEGER, allowNull: false },
    detail: json(), status: { type: DataTypes.ENUM("open", "true_match", "false_positive"), allowNull: false, defaultValue: "open" },
    disposed_by: str(64, true), disposed_reason: str(1000, true), disposed_at: dt(), ...ts(),
  });
  await qi.addIndex("screening_hits", ["tenant_id", "profile_id", "status"], { name: "ix_hits_profile" });
  await tenantFk(sequelize, "screening_hits", "run_id", "screening_runs");
  await tenantFk(sequelize, "screening_hits", "profile_id", "kyc_profiles");
  await tenantFk(sequelize, "screening_hits", "subject_contact_id", "contacts");

  await qi.createTable("compliance_cases", {
    id: id(), tenant_id: tenantId(), profile_id: uuid(false), kind: { type: DataTypes.ENUM("screening_hit", "high_risk", "suspicious_activity", "document_issue", "other"), allowNull: false },
    status: { type: DataTypes.ENUM("open", "escalated", "closed"), allowNull: false, defaultValue: "open" }, outcome: { type: DataTypes.ENUM("cleared", "reported", "rejected"), allowNull: true },
    summary: str(1000), assigned_user_id: uuid(), opened_by: str(64, true), closed_by: str(64, true), closed_at: dt(), resolution: str(1000, true), ...ts(),
  });
  await tenantKey(qi, "compliance_cases");
  await qi.addIndex("compliance_cases", ["tenant_id", "status"], { name: "ix_cases_status" });
  await tenantFk(sequelize, "compliance_cases", "profile_id", "kyc_profiles");
  await tenantFk(sequelize, "compliance_cases", "assigned_user_id", "users");

  await qi.createTable("case_events", {
    id: id(), tenant_id: tenantId(), case_id: uuid(false), type: str(40), detail: json(), actor_id: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("case_events", ["tenant_id", "case_id", "created_at"], { name: "ix_case_events" });
  await tenantFk(sequelize, "case_events", "case_id", "compliance_cases");
  await appendOnly(sequelize, "case_events");

  // Data-subject requests: statutory clock stored as a due date in the DB.
  await qi.createTable("dsr_requests", {
    id: id(), tenant_id: tenantId(), contact_id: uuid(false), kind: { type: DataTypes.ENUM("access", "rectification", "erasure", "restriction"), allowNull: false },
    status: { type: DataTypes.ENUM("received", "completed", "rejected"), allowNull: false, defaultValue: "received" }, due_at: { type: DataTypes.DATE(3), allowNull: false },
    note: str(1000, true), handled_by: str(64, true), completed_at: dt(), result: json(), overdue_notified_at: dt(), ...ts(),
  });
  await qi.addIndex("dsr_requests", ["tenant_id", "status", "due_at"], { name: "ix_dsr_due" });
  await tenantFk(sequelize, "dsr_requests", "contact_id", "contacts");

  await qi.createTable("retention_policies", {
    id: id(), tenant_id: tenantId(), entity_type: { type: DataTypes.ENUM("contact_archived", "kyc_profile", "message"), allowNull: false }, retain_days: { type: DataTypes.INTEGER, allowNull: false },
    action: { type: DataTypes.ENUM("anonymise", "delete_content"), allowNull: false, defaultValue: "anonymise" }, ...ts(),
  });
  await qi.addIndex("retention_policies", ["tenant_id", "entity_type"], { unique: true, name: "uq_retention_entity" });

  await qi.createTable("legal_holds", {
    id: id(), tenant_id: tenantId(), contact_id: uuid(false), reason: str(500), placed_by: str(64, true), released_by: str(64, true), released_at: dt(), ...ts(),
  });
  await qi.addIndex("legal_holds", ["tenant_id", "contact_id", "released_at"], { name: "ix_legal_holds" });
  await tenantFk(sequelize, "legal_holds", "contact_id", "contacts");
}

export async function down({ context: qi, sequelize }: Ctx) {
  await sequelize.query("DROP TRIGGER IF EXISTS case_events_no_update");
  await sequelize.query("DROP TRIGGER IF EXISTS case_events_no_delete");
  for (const t of ["legal_holds", "retention_policies", "dsr_requests", "case_events", "compliance_cases", "screening_hits", "screening_runs", "ubo_links", "kyc_documents", "kyc_profiles"]) await qi.dropTable(t);
}
