import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

const APPEND = ["no_update", "no_delete"] as const;
async function appendOnly(sequelize: any, table: string) {
  await sequelize.query(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
  await sequelize.query(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
}
async function dropAppendOnly(sequelize: any, table: string) {
  for (const k of APPEND) await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_${k}`);
}

export async function up({ context: qi, sequelize }: Ctx) {
  const money = (allowNull = false) => ({ type: DataTypes.DECIMAL(18, 2), allowNull });

  await qi.createTable("portfolios", {
    id: id(), tenant_id: tenantId(), name: str(180), owner_contact_id: uuid(false), branch_id: uuid(),
    status: { type: DataTypes.ENUM("active", "closed"), allowNull: false, defaultValue: "active" }, ...ts(),
  });
  await tenantKey(qi, "portfolios");
  await qi.addIndex("portfolios", ["tenant_id", "owner_contact_id"], { name: "ix_portfolios_owner" });
  await tenantFk(sequelize, "portfolios", "owner_contact_id", "contacts");
  await tenantFk(sequelize, "portfolios", "branch_id", "branches");

  await qi.createTable("ownerships", {
    id: id(), tenant_id: tenantId(), unit_id: uuid(false), portfolio_id: uuid(false), share_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 100 },
    from_date: { type: DataTypes.DATEONLY, allowNull: false }, to_date: { type: DataTypes.DATEONLY, allowNull: true }, ...ts(),
  });
  await tenantKey(qi, "ownerships");
  await qi.addIndex("ownerships", ["tenant_id", "unit_id", "to_date"], { name: "ix_ownerships_unit" });
  await qi.addIndex("ownerships", ["tenant_id", "portfolio_id"], { name: "ix_ownerships_portfolio" });
  await tenantFk(sequelize, "ownerships", "unit_id", "units");
  await tenantFk(sequelize, "ownerships", "portfolio_id", "portfolios");

  await qi.createTable("management_agreements", {
    id: id(), tenant_id: tenantId(), portfolio_id: uuid(false), fee_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
    starts_on: { type: DataTypes.DATEONLY, allowNull: false }, ends_on: { type: DataTypes.DATEONLY, allowNull: true },
    status: { type: DataTypes.ENUM("active", "ended"), allowNull: false, defaultValue: "active" }, document_id: uuid(), ...ts(),
  });
  await tenantKey(qi, "management_agreements");
  await tenantFk(sequelize, "management_agreements", "portfolio_id", "portfolios");
  await tenantFk(sequelize, "management_agreements", "document_id", "documents");

  await qi.createTable("leases", {
    id: id(), tenant_id: tenantId(), unit_id: uuid(false), portfolio_id: uuid(), branch_id: uuid(), agent_user_id: uuid(), previous_lease_id: uuid(),
    status: { type: DataTypes.ENUM("draft", "active", "ended", "terminated"), allowNull: false, defaultValue: "draft" },
    starts_on: { type: DataTypes.DATEONLY, allowNull: false }, ends_on: { type: DataTypes.DATEONLY, allowNull: false },
    annual_rent: money(), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" }, installments: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    registration_ref: str(80, true), contract_document_id: uuid(), jurisdiction_code: str(40),
    notice_given_on: { type: DataTypes.DATEONLY, allowNull: true }, terminated_on: { type: DataTypes.DATEONLY, allowNull: true }, termination_reason: str(500, true),
    activated_at: dt(), created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "leases");
  await qi.addIndex("leases", ["tenant_id", "status", "ends_on"], { name: "ix_leases_status_end" });
  await qi.addIndex("leases", ["tenant_id", "unit_id", "status"], { name: "ix_leases_unit" });
  await qi.addIndex("leases", ["tenant_id", "portfolio_id", "status"], { name: "ix_leases_portfolio" });
  for (const [c, p] of [["unit_id", "units"], ["portfolio_id", "portfolios"], ["branch_id", "branches"], ["agent_user_id", "users"], ["previous_lease_id", "leases"], ["contract_document_id", "documents"]] as const) await tenantFk(sequelize, "leases", c, p);

  await qi.createTable("lease_parties", {
    id: id(), tenant_id: tenantId(), lease_id: uuid(false), contact_id: uuid(false),
    role: { type: DataTypes.ENUM("tenant", "landlord", "guarantor", "occupant"), allowNull: false }, ...ts(),
  });
  await qi.addIndex("lease_parties", ["tenant_id", "lease_id", "contact_id", "role"], { unique: true, name: "uq_lease_parties" });
  await tenantFk(sequelize, "lease_parties", "lease_id", "leases", "CASCADE");
  await tenantFk(sequelize, "lease_parties", "contact_id", "contacts");

  await qi.createTable("lease_addenda", {
    id: id(), tenant_id: tenantId(), lease_id: uuid(false), title: str(255), effective_on: { type: DataTypes.DATEONLY, allowNull: false }, changes: json(), document_id: uuid(), created_by: str(64, true),
    created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("lease_addenda", ["tenant_id", "lease_id"], { name: "ix_lease_addenda" });
  await tenantFk(sequelize, "lease_addenda", "lease_id", "leases");
  await tenantFk(sequelize, "lease_addenda", "document_id", "documents");
  await appendOnly(sequelize, "lease_addenda");

  // The rent schedule must always sum to the annual rent exactly: generated with largest-remainder allocation.
  await qi.createTable("rent_schedules", {
    id: id(), tenant_id: tenantId(), lease_id: uuid(false), seq: { type: DataTypes.INTEGER, allowNull: false }, due_date: { type: DataTypes.DATEONLY, allowNull: false },
    amount: money(), paid_amount: { ...money(), defaultValue: 0 },
    status: { type: DataTypes.ENUM("pending", "partial", "paid", "overdue", "waived", "cancelled"), allowNull: false, defaultValue: "pending" },
    overdue_notified_at: dt(), ...ts(),
  });
  await tenantKey(qi, "rent_schedules");
  await qi.addIndex("rent_schedules", ["tenant_id", "lease_id", "seq"], { unique: true, name: "uq_rent_schedule_seq" });
  await qi.addIndex("rent_schedules", ["tenant_id", "status", "due_date"], { name: "ix_rent_schedule_due" });
  await tenantFk(sequelize, "rent_schedules", "lease_id", "leases", "CASCADE");

  await qi.createTable("rent_allocations", {
    id: id(), tenant_id: tenantId(), payment_id: uuid(false), rent_schedule_id: uuid(false), amount: money(), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("rent_allocations", ["tenant_id", "payment_id", "rent_schedule_id"], { unique: true, name: "uq_rent_allocation" });
  await qi.addIndex("rent_allocations", ["tenant_id", "rent_schedule_id"], { name: "ix_rent_allocations_schedule" });
  await tenantFk(sequelize, "rent_allocations", "payment_id", "payments");
  await tenantFk(sequelize, "rent_allocations", "rent_schedule_id", "rent_schedules");
  await appendOnly(sequelize, "rent_allocations");

  await qi.createTable("security_deposits", {
    id: id(), tenant_id: tenantId(), lease_id: uuid(false), amount: money(), status: { type: DataTypes.ENUM("pending", "held", "released"), allowNull: false, defaultValue: "pending" }, ...ts(),
  });
  await tenantKey(qi, "security_deposits");
  await qi.addIndex("security_deposits", ["tenant_id", "lease_id"], { unique: true, name: "uq_security_deposit_lease" });
  await tenantFk(sequelize, "security_deposits", "lease_id", "leases");

  // Every movement of deposit money is an immutable row: collected (+), deducted (-), refunded (-).
  await qi.createTable("deposit_movements", {
    id: id(), tenant_id: tenantId(), deposit_id: uuid(false), kind: { type: DataTypes.ENUM("collect", "deduct", "refund"), allowNull: false }, amount: money(),
    reason: str(255, true), payment_id: uuid(), actor_id: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("deposit_movements", ["tenant_id", "deposit_id", "created_at"], { name: "ix_deposit_movements" });
  await tenantFk(sequelize, "deposit_movements", "deposit_id", "security_deposits");
  await tenantFk(sequelize, "deposit_movements", "payment_id", "payments");
  await appendOnly(sequelize, "deposit_movements");

  // Dedupes lease milestone notifications (expiring in 90/60/30 days) so a daily sweep never repeats them.
  await qi.createTable("lease_milestones", {
    id: id(), tenant_id: tenantId(), lease_id: uuid(false), kind: str(30), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("lease_milestones", ["tenant_id", "lease_id", "kind"], { unique: true, name: "uq_lease_milestones" });
  await tenantFk(sequelize, "lease_milestones", "lease_id", "leases", "CASCADE");
}

export async function down({ context: qi, sequelize }: Ctx) {
  for (const t of ["rent_allocations", "deposit_movements", "lease_addenda"]) await dropAppendOnly(sequelize, t);
  for (const t of ["lease_milestones", "deposit_movements", "security_deposits", "rent_allocations", "rent_schedules", "lease_addenda", "lease_parties", "leases", "management_agreements", "ownerships", "portfolios"]) await qi.dropTable(t);
}
