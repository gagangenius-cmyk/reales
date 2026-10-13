import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("real_estate_projects", {
    id: id(), tenant_id: tenantId(), developer_id: uuid(), crm_project_id: uuid(),
    name: str(180), jurisdiction_code: str(40), kind: { type: DataTypes.ENUM("ready", "off_plan"), allowNull: false },
    registration_no: str(80, true), escrow_account_ref: str(120, true), handover_date: { type: DataTypes.DATEONLY, allowNull: true },
    status: { type: DataTypes.ENUM("planning", "selling", "completed", "archived"), allowNull: false, defaultValue: "selling" }, ...ts(),
  });
  await tenantKey(qi, "real_estate_projects");
  await qi.addIndex("real_estate_projects", ["tenant_id", "status"], { name: "ix_re_projects_tenant_status" });
  await tenantFk(sequelize, "real_estate_projects", "developer_id", "developers");
  await tenantFk(sequelize, "real_estate_projects", "crm_project_id", "projects");

  await qi.createTable("buildings", {
    id: id(), tenant_id: tenantId(), re_project_id: uuid(false), name: str(180), community: str(120, true), city: str(80, true),
    floors_count: { type: DataTypes.INTEGER, allowNull: true }, ...ts(),
  });
  await tenantKey(qi, "buildings");
  await qi.addIndex("buildings", ["tenant_id", "re_project_id"], { name: "ix_buildings_tenant_project" });
  await tenantFk(sequelize, "buildings", "re_project_id", "real_estate_projects");

  await qi.createTable("units", {
    id: id(), tenant_id: tenantId(), building_id: uuid(false), unit_number: str(40), floor: { type: DataTypes.INTEGER, allowNull: true },
    type: { type: DataTypes.ENUM("apartment", "villa", "townhouse", "penthouse", "office", "retail", "land"), allowNull: false },
    bedrooms: { type: DataTypes.INTEGER, allowNull: true }, bathrooms: { type: DataTypes.INTEGER, allowNull: true },
    area_sqft: { type: DataTypes.DECIMAL(12, 2), allowNull: true }, view: str(80, true),
    status: { type: DataTypes.ENUM("available", "reserved", "sold", "rented", "blocked"), allowNull: false, defaultValue: "available" },
    list_price: { type: DataTypes.DECIMAL(18, 2), allowNull: true }, currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    owner_contact_id: uuid(), ...ts(),
  });
  await tenantKey(qi, "units");
  await qi.addIndex("units", ["tenant_id", "building_id", "unit_number"], { unique: true, name: "uq_units_building_number" });
  await qi.addIndex("units", ["tenant_id", "status", "type"], { name: "ix_units_tenant_status_type" });
  await tenantFk(sequelize, "units", "building_id", "buildings");
  await tenantFk(sequelize, "units", "owner_contact_id", "contacts");
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["units", "buildings", "real_estate_projects"]) await qi.dropTable(t);
}
