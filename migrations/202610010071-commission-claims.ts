import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk, step } from "./_helpers";

/**
 * Commission claim batches: finance gathers approved commissions into a batch that moves through maker/checker stages
 * (draft, submitted, verified, approved, scheduled, released) with evidence, an append-only decision log, and reversal.
 */
export async function up({ context: qi, sequelize }: Ctx) {
  const money = (allowNull = false) => ({ type: DataTypes.DECIMAL(18, 2), allowNull, defaultValue: allowNull ? null : "0.00" });
  await step(() => qi.createTable("commission_claim_batches", {
    id: id(), tenant_id: tenantId(), number: { type: DataTypes.INTEGER, allowNull: false }, title: str(160),
    status: { type: DataTypes.ENUM("draft", "submitted", "verified", "approved", "scheduled", "released", "rejected", "cancelled", "reversed"), allowNull: false, defaultValue: "draft" },
    currency: str(3), amount: money(), vat_amount: money(), item_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, notes: str(500, true),
    created_by: uuid(false), submitted_by: uuid(), submitted_at: dt(), verified_by: uuid(), verified_at: dt(), approved_by: uuid(), approved_at: dt(),
    scheduled_for: { type: DataTypes.DATEONLY, allowNull: true }, scheduled_by: uuid(), released_by: uuid(), released_at: dt(), release_reference: str(120, true),
    reversed_by: uuid(), reversed_at: dt(), reversal_reason: str(255, true), rejection_reason: str(255, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "commission_claim_batches"));
  await step(() => qi.addIndex("commission_claim_batches", ["tenant_id", "number"], { unique: true, name: "uq_claim_batch_number" }));
  await step(() => qi.addIndex("commission_claim_batches", ["tenant_id", "status", "scheduled_for"], { name: "ix_claim_batch_status" }));

  await step(() => qi.createTable("commission_claim_items", {
    id: id(), tenant_id: tenantId(), batch_id: uuid(false), calculation_id: uuid(false), payee_user_id: uuid(),
    amount: money(), vat_amount: money(), currency: str(3),
    /** 1 while the item is part of a live batch, NULL once released/removed/rejected; the unique key below allows a commission one live claim only. */
    live: { type: DataTypes.TINYINT, allowNull: true },
    verification: { type: DataTypes.ENUM("pending", "verified", "flagged"), allowNull: false, defaultValue: "pending" }, verification_note: str(255, true), verified_by: uuid(), verified_at: dt(), ...ts(),
  }));
  await step(() => tenantKey(qi, "commission_claim_items"));
  await step(() => tenantFk(sequelize, "commission_claim_items", "batch_id", "commission_claim_batches"));
  await step(() => tenantFk(sequelize, "commission_claim_items", "calculation_id", "commission_calculations"));
  await step(() => qi.addIndex("commission_claim_items", ["tenant_id", "calculation_id", "live"], { unique: true, name: "uq_claim_item_live" }));
  await step(() => qi.addIndex("commission_claim_items", ["tenant_id", "batch_id"], { name: "ix_claim_item_batch" }));

  await step(() => qi.createTable("commission_claim_evidence", {
    id: id(), tenant_id: tenantId(), batch_id: uuid(false), item_id: uuid(),
    kind: { type: DataTypes.ENUM("bank_statement", "invoice", "contract", "email", "other"), allowNull: false }, description: str(300), document_id: uuid(), added_by: uuid(false), ...ts(),
  }));
  await step(() => tenantFk(sequelize, "commission_claim_evidence", "batch_id", "commission_claim_batches"));
  await step(() => qi.addIndex("commission_claim_evidence", ["tenant_id", "batch_id"], { name: "ix_claim_evidence_batch" }));

  await step(() => qi.createTable("commission_claim_decisions", {
    id: id(), tenant_id: tenantId(), batch_id: uuid(false),
    stage: { type: DataTypes.ENUM("submit", "verify", "approve", "schedule", "release", "reverse", "reject", "cancel"), allowNull: false }, reason: str(255, true), actor_id: uuid(false),
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  }));
  await step(() => tenantFk(sequelize, "commission_claim_decisions", "batch_id", "commission_claim_batches"));
  await step(() => qi.addIndex("commission_claim_decisions", ["tenant_id", "batch_id", "created_at"], { name: "ix_claim_decision_batch" }));
  // The decision log is evidence: nobody, including the application, may edit or delete a row.
  const T = "commission_claim_decisions";
  await step(() => sequelize.query(`CREATE TRIGGER ${T}_no_update BEFORE UPDATE ON ${T} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${T} is append-only'`));
  await step(() => sequelize.query(`CREATE TRIGGER ${T}_no_delete BEFORE DELETE ON ${T} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${T} is append-only'`));
}
export async function down({ context: qi, sequelize }: Ctx) {
  await sequelize.query("DROP TRIGGER IF EXISTS commission_claim_decisions_no_update");
  await sequelize.query("DROP TRIGGER IF EXISTS commission_claim_decisions_no_delete");
  await qi.dropTable("commission_claim_decisions");
  await qi.dropTable("commission_claim_evidence");
  await qi.dropTable("commission_claim_items");
  await qi.dropTable("commission_claim_batches");
}
