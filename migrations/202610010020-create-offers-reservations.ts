import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, json, tenantKey, tenantFk } from "./_helpers";

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
  await qi.createTable("offers", {
    id: id(), tenant_id: tenantId(), lead_id: uuid(), contact_id: uuid(false), unit_id: uuid(false), listing_id: uuid(),
    agent_user_id: uuid(false), branch_id: uuid(), project_id: uuid(),
    status: { type: DataTypes.ENUM("draft", "submitted", "countered", "accepted", "rejected", "withdrawn", "expired"), allowNull: false, defaultValue: "draft" },
    current_amount: money(false), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" }, deposit_amount: money(),
    valid_until: { type: DataTypes.DATE(3), allowNull: true }, created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "offers");
  await qi.addIndex("offers", ["tenant_id", "status", "valid_until"], { name: "ix_offers_status_valid" });
  await qi.addIndex("offers", ["tenant_id", "unit_id", "status"], { name: "ix_offers_unit" });
  for (const [c, p] of [["lead_id", "leads"], ["contact_id", "contacts"], ["unit_id", "units"], ["listing_id", "listings"], ["agent_user_id", "users"], ["branch_id", "branches"], ["project_id", "projects"]] as const) await tenantFk(sequelize, "offers", c, p);

  await qi.createTable("offer_revisions", {
    id: id(), tenant_id: tenantId(), offer_id: uuid(false), revision: { type: DataTypes.INTEGER, allowNull: false }, amount: money(false),
    terms: json(), by_party: { type: DataTypes.ENUM("buyer", "seller"), allowNull: false }, created_by: str(64, true),
    created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("offer_revisions", ["tenant_id", "offer_id", "revision"], { unique: true, name: "uq_offer_revision" });
  await tenantFk(sequelize, "offer_revisions", "offer_id", "offers");
  await appendOnly(sequelize, "offer_revisions");

  await qi.createTable("reservations", {
    id: id(), tenant_id: tenantId(), unit_id: uuid(false), contact_id: uuid(false), offer_id: uuid(), deal_id: uuid(),
    status: { type: DataTypes.ENUM("active", "converted", "cancelled", "expired"), allowNull: false, defaultValue: "active" },
    expires_at: { type: DataTypes.DATE(3), allowNull: false }, deposit_amount: money(), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "reservations");
  await qi.addIndex("reservations", ["tenant_id", "status", "expires_at"], { name: "ix_reservations_status_expiry" });
  await tenantFk(sequelize, "reservations", "unit_id", "units");
  await tenantFk(sequelize, "reservations", "contact_id", "contacts");
  await tenantFk(sequelize, "reservations", "offer_id", "offers");
  // The database itself guarantees a unit never has two ACTIVE reservations (generated column is NULL for inactive rows).
  await sequelize.query("ALTER TABLE reservations ADD COLUMN active_unit_id CHAR(36) GENERATED ALWAYS AS (IF(status = 'active', unit_id, NULL)) STORED");
  await sequelize.query("ALTER TABLE reservations ADD UNIQUE INDEX uq_reservations_active_unit (tenant_id, active_unit_id)");
}
export async function down({ context: qi, sequelize }: Ctx) {
  await dropAppendOnly(sequelize, "offer_revisions");
  for (const t of ["reservations", "offer_revisions", "offers"]) await qi.dropTable(t);
}
