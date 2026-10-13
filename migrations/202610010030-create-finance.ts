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
  const money = (allowNull = false) => ({ type: DataTypes.DECIMAL(18, 2), allowNull });

  // Atomic per-tenant sequences (invoice / receipt numbers).
  await qi.createTable("counters", {
    tenant_id: { ...tenantId(), primaryKey: true }, counter_key: { type: DataTypes.STRING(40), allowNull: false, primaryKey: true },
    value: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  });

  await qi.createTable("invoices", {
    id: id(), tenant_id: tenantId(), number: str(40), deal_id: uuid(), contact_id: uuid(false), branch_id: uuid(),
    status: { type: DataTypes.ENUM("draft", "issued", "partially_paid", "paid", "void"), allowNull: false, defaultValue: "draft" },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    subtotal: money(), vat_amount: money(), total: money(), due_date: { type: DataTypes.DATEONLY, allowNull: true },
    issued_at: dt(), voided_at: dt(), void_reason: str(255, true), created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "invoices");
  await qi.addIndex("invoices", ["tenant_id", "number"], { unique: true, name: "uq_invoices_number" });
  await qi.addIndex("invoices", ["tenant_id", "status", "due_date"], { name: "ix_invoices_status_due" });
  await tenantFk(sequelize, "invoices", "deal_id", "deals");
  await tenantFk(sequelize, "invoices", "contact_id", "contacts");
  await tenantFk(sequelize, "invoices", "branch_id", "branches");

  await qi.createTable("invoice_lines", {
    id: id(), tenant_id: tenantId(), invoice_id: uuid(false), description: str(255), quantity: { type: DataTypes.DECIMAL(12, 3), allowNull: false },
    unit_price: money(), vat_rate: { type: DataTypes.DECIMAL(5, 2), allowNull: false }, amount: money(), vat_amount: money(), sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  });
  await qi.addIndex("invoice_lines", ["tenant_id", "invoice_id"], { name: "ix_invoice_lines_invoice" });
  await tenantFk(sequelize, "invoice_lines", "invoice_id", "invoices", "CASCADE");

  await qi.createTable("payments", {
    id: id(), tenant_id: tenantId(), contact_id: uuid(false), deal_id: uuid(), milestone_id: uuid(), invoice_id: uuid(),
    amount: money(), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    method: { type: DataTypes.ENUM("card", "bank_transfer", "cheque", "cash"), allowNull: false },
    provider: str(40), provider_ref: str(120, true),
    status: { type: DataTypes.ENUM("pending", "succeeded", "failed"), allowNull: false, defaultValue: "pending" },
    received_at: dt(), failure_reason: str(255, true), created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "payments");
  // Unique per tenant: a user-typed reference (manual bank transfer) must never collide across tenants. The plain index serves webhook lookups.
  await qi.addIndex("payments", ["tenant_id", "provider", "provider_ref"], { unique: true, name: "uq_payments_provider_ref" });
  await qi.addIndex("payments", ["provider", "provider_ref"], { name: "ix_payments_provider_ref" });
  await qi.addIndex("payments", ["tenant_id", "status", "created_at"], { name: "ix_payments_status" });
  await tenantFk(sequelize, "payments", "contact_id", "contacts");
  await tenantFk(sequelize, "payments", "deal_id", "deals");
  await tenantFk(sequelize, "payments", "milestone_id", "deal_milestones");
  await tenantFk(sequelize, "payments", "invoice_id", "invoices");

  await qi.createTable("payment_allocations", {
    id: id(), tenant_id: tenantId(), payment_id: uuid(false), invoice_id: uuid(false), amount: money(), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("payment_allocations", ["tenant_id", "payment_id", "invoice_id"], { unique: true, name: "uq_payment_allocation" });
  await qi.addIndex("payment_allocations", ["tenant_id", "invoice_id"], { name: "ix_payment_allocations_invoice" });
  await tenantFk(sequelize, "payment_allocations", "payment_id", "payments");
  await tenantFk(sequelize, "payment_allocations", "invoice_id", "invoices");
  await appendOnly(sequelize, "payment_allocations");

  await qi.createTable("receipts", {
    id: id(), tenant_id: tenantId(), payment_id: uuid(false), number: str(40), issued_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("receipts", ["tenant_id", "number"], { unique: true, name: "uq_receipts_number" });
  await qi.addIndex("receipts", ["tenant_id", "payment_id"], { unique: true, name: "uq_receipts_payment" });
  await tenantFk(sequelize, "receipts", "payment_id", "payments");

  // Raw provider callbacks are persisted first (blueprint: verify -> dedupe -> persist -> ack -> process asynchronously).
  await qi.createTable("webhook_events", {
    id: id(), tenant_id: { ...uuid(true), references: { model: "tenants", key: "id" } }, provider: str(40), kind: str(20), event_id: str(160),
    raw_body: { type: DataTypes.TEXT("medium"), allowNull: false }, signature_valid: { type: DataTypes.BOOLEAN, allowNull: false },
    status: { type: DataTypes.ENUM("received", "processed", "failed", "ignored"), allowNull: false, defaultValue: "received" },
    error: { type: DataTypes.TEXT, allowNull: true }, received_at: { type: DataTypes.DATE(3), allowNull: false }, processed_at: dt(),
  });
  await qi.addIndex("webhook_events", ["provider", "kind", "event_id"], { unique: true, name: "uq_webhook_events" });
  await qi.addIndex("webhook_events", ["tenant_id", "status", "received_at"], { name: "ix_webhook_events_status" });
}
export async function down({ context: qi, sequelize }: Ctx) {
  await dropAppendOnly(sequelize, "payment_allocations");
  for (const t of ["webhook_events", "receipts", "payment_allocations", "payments", "invoice_lines", "invoices", "counters"]) await qi.dropTable(t);
}
