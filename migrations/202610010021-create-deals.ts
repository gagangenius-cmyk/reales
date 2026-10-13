import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk } from "./_helpers";

async function appendOnly(sequelize: any, table: string) {
  await sequelize.query(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
  await sequelize.query(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
}
async function dropAppendOnly(sequelize: any, table: string) {
  await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_no_update`);
  await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_no_delete`);
}

export async function up({ context: qi, sequelize }: Ctx) {
  const money = (allowNull = true) => ({ type: DataTypes.DECIMAL(18, 2), allowNull });
  await qi.createTable("deals", {
    id: id(), tenant_id: tenantId(), deal_type: { type: DataTypes.ENUM("sale", "lease"), allowNull: false },
    lead_id: uuid(), unit_id: uuid(false), contact_id: uuid(false), offer_id: uuid(), reservation_id: uuid(),
    agent_user_id: uuid(false), branch_id: uuid(), project_id: uuid(),
    // `stage` is the current projection; deal_stage_events is the historical truth.
    stage: { type: DataTypes.ENUM("reserved", "contract", "signed", "payment", "registration", "closed", "cancelled"), allowNull: false, defaultValue: "reserved" },
    status: { type: DataTypes.ENUM("open", "closed", "cancelled"), allowNull: false, defaultValue: "open" },
    amount: money(false), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    cancelled_reason: str(255, true), closed_at: dt(), created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "deals");
  await qi.addIndex("deals", ["tenant_id", "stage"], { name: "ix_deals_stage" });
  await qi.addIndex("deals", ["tenant_id", "agent_user_id", "status"], { name: "ix_deals_agent" });
  await qi.addIndex("deals", ["tenant_id", "unit_id", "status"], { name: "ix_deals_unit" });
  for (const [c, p] of [["lead_id", "leads"], ["unit_id", "units"], ["contact_id", "contacts"], ["offer_id", "offers"], ["reservation_id", "reservations"], ["agent_user_id", "users"], ["branch_id", "branches"], ["project_id", "projects"]] as const) await tenantFk(sequelize, "deals", c, p);
  // One live deal per unit at a time (open deals only).
  await sequelize.query("ALTER TABLE deals ADD COLUMN open_unit_id CHAR(36) GENERATED ALWAYS AS (IF(status = 'open', unit_id, NULL)) STORED");
  await sequelize.query("ALTER TABLE deals ADD UNIQUE INDEX uq_deals_open_unit (tenant_id, open_unit_id)");
  await tenantFk(sequelize, "reservations", "deal_id", "deals");

  await qi.createTable("deal_stage_events", {
    id: id(), tenant_id: tenantId(), deal_id: uuid(false), from_stage: str(20, true), to_stage: str(20), actor_id: str(64, true), reason: str(255, true),
    created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("deal_stage_events", ["tenant_id", "deal_id", "created_at"], { name: "ix_deal_stage_events" });
  await tenantFk(sequelize, "deal_stage_events", "deal_id", "deals");
  await appendOnly(sequelize, "deal_stage_events");

  await qi.createTable("deal_parties", {
    id: id(), tenant_id: tenantId(), deal_id: uuid(false), contact_id: uuid(false),
    role: { type: DataTypes.ENUM("buyer", "seller", "tenant", "landlord", "introducer"), allowNull: false },
    share_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true }, ...ts(),
  });
  await qi.addIndex("deal_parties", ["tenant_id", "deal_id", "contact_id", "role"], { unique: true, name: "uq_deal_parties" });
  await tenantFk(sequelize, "deal_parties", "deal_id", "deals", "CASCADE");
  await tenantFk(sequelize, "deal_parties", "contact_id", "contacts");

  await qi.createTable("deal_milestones", {
    id: id(), tenant_id: tenantId(), deal_id: uuid(false), key: str(60), title: str(180), sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    due_date: { type: DataTypes.DATEONLY, allowNull: true }, amount: money(),
    status: { type: DataTypes.ENUM("pending", "done", "waived"), allowNull: false, defaultValue: "pending" },
    completed_at: dt(), completed_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "deal_milestones");
  await qi.addIndex("deal_milestones", ["tenant_id", "deal_id", "key"], { unique: true, name: "uq_deal_milestone_key" });
  await qi.addIndex("deal_milestones", ["tenant_id", "status", "due_date"], { name: "ix_deal_milestones_due" });
  await tenantFk(sequelize, "deal_milestones", "deal_id", "deals", "CASCADE");
}
export async function down({ context: qi, sequelize }: Ctx) {
  await dropAppendOnly(sequelize, "deal_stage_events");
  await sequelize.query("ALTER TABLE reservations DROP FOREIGN KEY fk_reservations_deal_id");
  for (const t of ["deal_milestones", "deal_parties", "deal_stage_events", "deals"]) await qi.dropTable(t);
}
