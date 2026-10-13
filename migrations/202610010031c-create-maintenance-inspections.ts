import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

async function appendOnly(sequelize: any, table: string) {
  await sequelize.query(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
  await sequelize.query(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
}

export async function up({ context: qi, sequelize }: Ctx) {
  const money = (allowNull = false) => ({ type: DataTypes.DECIMAL(18, 2), allowNull });

  await qi.createTable("vendors", {
    id: id(), tenant_id: tenantId(), name: str(180), categories: json(), contact_name: str(120, true), phone_e164: str(32, true), email: str(254, true),
    trade_licence_no: str(80, true), licence_expires_on: { type: DataTypes.DATEONLY, allowNull: true },
    status: { type: DataTypes.ENUM("active", "suspended"), allowNull: false, defaultValue: "active" }, ...ts(),
  });
  await tenantKey(qi, "vendors");
  await qi.addIndex("vendors", ["tenant_id", "status"], { name: "ix_vendors_status" });

  await qi.createTable("maintenance_tickets", {
    id: id(), tenant_id: tenantId(), unit_id: uuid(false), lease_id: uuid(), portfolio_id: uuid(), branch_id: uuid(), reporter_contact_id: uuid(), assigned_user_id: uuid(),
    category: { type: DataTypes.ENUM("plumbing", "electrical", "hvac", "appliance", "structural", "cleaning", "pest", "other"), allowNull: false },
    priority: { type: DataTypes.ENUM("urgent", "high", "normal", "low"), allowNull: false, defaultValue: "normal" },
    status: { type: DataTypes.ENUM("new", "triaged", "quoted", "approved", "in_progress", "completed", "closed", "cancelled"), allowNull: false, defaultValue: "new" },
    title: str(255), description: { type: DataTypes.TEXT, allowNull: true }, sla_due_at: { type: DataTypes.DATE(3), allowNull: false }, sla_breached_at: dt(),
    resolved_at: dt(), created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "maintenance_tickets");
  await qi.addIndex("maintenance_tickets", ["tenant_id", "status", "sla_due_at"], { name: "ix_tickets_sla" });
  await qi.addIndex("maintenance_tickets", ["tenant_id", "unit_id", "status"], { name: "ix_tickets_unit" });
  await qi.addIndex("maintenance_tickets", ["tenant_id", "assigned_user_id", "status"], { name: "ix_tickets_assignee" });
  for (const [c, p] of [["unit_id", "units"], ["lease_id", "leases"], ["portfolio_id", "portfolios"], ["branch_id", "branches"], ["reporter_contact_id", "contacts"], ["assigned_user_id", "users"]] as const) await tenantFk(sequelize, "maintenance_tickets", c, p);

  await qi.createTable("quotations", {
    id: id(), tenant_id: tenantId(), ticket_id: uuid(false), vendor_id: uuid(false), amount: money(), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    status: { type: DataTypes.ENUM("submitted", "approved", "rejected"), allowNull: false, defaultValue: "submitted" }, notes: str(500, true), decided_by: str(64, true), decided_at: dt(), ...ts(),
  });
  await tenantKey(qi, "quotations");
  await qi.addIndex("quotations", ["tenant_id", "ticket_id", "status"], { name: "ix_quotations_ticket" });
  await tenantFk(sequelize, "quotations", "ticket_id", "maintenance_tickets");
  await tenantFk(sequelize, "quotations", "vendor_id", "vendors");

  await qi.createTable("work_orders", {
    id: id(), tenant_id: tenantId(), ticket_id: uuid(false), vendor_id: uuid(false), quotation_id: uuid(), scheduled_at: dt(), completed_at: dt(),
    status: { type: DataTypes.ENUM("issued", "in_progress", "completed", "cancelled"), allowNull: false, defaultValue: "issued" },
    quoted_amount: money(true), final_cost: money(true), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" }, ...ts(),
  });
  await tenantKey(qi, "work_orders");
  await qi.addIndex("work_orders", ["tenant_id", "ticket_id", "status"], { name: "ix_work_orders_ticket" });
  await tenantFk(sequelize, "work_orders", "ticket_id", "maintenance_tickets");
  await tenantFk(sequelize, "work_orders", "vendor_id", "vendors");
  await tenantFk(sequelize, "work_orders", "quotation_id", "quotations");

  await qi.createTable("work_order_events", {
    id: id(), tenant_id: tenantId(), work_order_id: uuid(), ticket_id: uuid(false), type: str(40), detail: json(), actor_id: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("work_order_events", ["tenant_id", "ticket_id", "created_at"], { name: "ix_wo_events_ticket" });
  await tenantFk(sequelize, "work_order_events", "ticket_id", "maintenance_tickets");
  await appendOnly(sequelize, "work_order_events");

  await qi.createTable("inspection_templates", {
    id: id(), tenant_id: tenantId(), name: str(160), kind: { type: DataTypes.ENUM("move_in", "move_out", "periodic"), allowNull: false }, items: json(false), ...ts(),
  });
  await tenantKey(qi, "inspection_templates");
  await qi.addIndex("inspection_templates", ["tenant_id", "name"], { unique: true, name: "uq_inspection_templates" });

  await qi.createTable("inspections", {
    id: id(), tenant_id: tenantId(), unit_id: uuid(false), lease_id: uuid(), template_id: uuid(), inspector_user_id: uuid(false), branch_id: uuid(), portfolio_id: uuid(),
    kind: { type: DataTypes.ENUM("move_in", "move_out", "periodic"), allowNull: false },
    status: { type: DataTypes.ENUM("scheduled", "in_progress", "completed", "signed"), allowNull: false, defaultValue: "scheduled" },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }, scheduled_for: dt(), completed_at: dt(), signed_by_contact_id: uuid(), signed_at: dt(), summary: { type: DataTypes.TEXT, allowNull: true }, ...ts(),
  });
  await tenantKey(qi, "inspections");
  await qi.addIndex("inspections", ["tenant_id", "inspector_user_id", "status"], { name: "ix_inspections_inspector" });
  await qi.addIndex("inspections", ["tenant_id", "unit_id", "kind"], { name: "ix_inspections_unit" });
  for (const [c, p] of [["unit_id", "units"], ["lease_id", "leases"], ["template_id", "inspection_templates"], ["inspector_user_id", "users"], ["branch_id", "branches"], ["portfolio_id", "portfolios"], ["signed_by_contact_id", "contacts"]] as const) await tenantFk(sequelize, "inspections", c, p);

  await qi.createTable("inspection_items", {
    id: id(), tenant_id: tenantId(), inspection_id: uuid(false), label: str(200), area: str(80, true),
    condition: { type: DataTypes.ENUM("good", "fair", "poor", "damaged", "na"), allowNull: false, defaultValue: "na" }, notes: str(1000, true), meter_reading: { type: DataTypes.DECIMAL(12, 2), allowNull: true }, version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, ...ts(),
  });
  await qi.addIndex("inspection_items", ["tenant_id", "inspection_id"], { name: "ix_inspection_items" });
  await tenantFk(sequelize, "inspection_items", "inspection_id", "inspections", "CASCADE");

  await qi.createTable("inspection_media", {
    id: id(), tenant_id: tenantId(), inspection_id: uuid(false), item_id: uuid(), document_id: uuid(false), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("inspection_media", ["tenant_id", "inspection_id"], { name: "ix_inspection_media" });
  await tenantFk(sequelize, "inspection_media", "inspection_id", "inspections", "CASCADE");
  await tenantFk(sequelize, "inspection_media", "document_id", "documents");

  // Offline sync: each client mutation carries an id; replays are no-ops (the mutation journal from the blueprint).
  await qi.createTable("inspection_mutations", {
    id: id(), tenant_id: tenantId(), inspection_id: uuid(false), client_mutation_id: str(80), applied_version: { type: DataTypes.INTEGER, allowNull: false }, created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("inspection_mutations", ["tenant_id", "inspection_id", "client_mutation_id"], { unique: true, name: "uq_inspection_mutation" });
  await tenantFk(sequelize, "inspection_mutations", "inspection_id", "inspections", "CASCADE");

  await qi.createTable("owner_statements", {
    id: id(), tenant_id: tenantId(), portfolio_id: uuid(false), period: str(7), // YYYY-MM
    rent_collected: money(), management_fee: money(), maintenance_cost: money(), net_payable: money(), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    detail: json(), status: { type: DataTypes.ENUM("draft", "issued"), allowNull: false, defaultValue: "draft" }, issued_at: dt(), ...ts(),
  });
  await tenantKey(qi, "owner_statements");
  await qi.addIndex("owner_statements", ["tenant_id", "portfolio_id", "period"], { unique: true, name: "uq_owner_statement_period" });
  await tenantFk(sequelize, "owner_statements", "portfolio_id", "portfolios");
}

export async function down({ context: qi, sequelize }: Ctx) {
  await sequelize.query("DROP TRIGGER IF EXISTS work_order_events_no_update");
  await sequelize.query("DROP TRIGGER IF EXISTS work_order_events_no_delete");
  for (const t of ["owner_statements", "inspection_mutations", "inspection_media", "inspection_items", "inspections", "inspection_templates", "work_order_events", "work_orders", "quotations", "maintenance_tickets", "vendors"]) await qi.dropTable(t);
}
