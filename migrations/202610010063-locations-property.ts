import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, tenantKey, step } from "./_helpers";

/**
 * A location catalogue (emirate > community > sub-community) with coordinates and the Bayut / Property Finder location ids, richer property facts on units,
 * and the listing facts portals ask for (completion status, ownership, age, availability, utilities).
 */
export async function up({ context: qi, sequelize }: Ctx) {
  await step(() => qi.createTable("locations", {
    id: id(), tenant_id: tenantId(), emirate: str(40), community: str(120), sub_community: str(120, true), path_key: str(300), latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true }, longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    bayut_id: str(60, true), pf_id: str(60, true), active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, ...ts(),
  }));
  await step(() => tenantKey(qi, "locations"));
  await step(() => qi.addIndex("locations", ["tenant_id", "path_key"], { unique: true, name: "uq_locations_path" }));
  await step(() => qi.addIndex("locations", ["tenant_id", "emirate", "community"], { name: "ix_locations_lookup" }));

  await step(() => qi.addColumn("buildings", "sub_community", str(120, true)));
  await step(() => qi.addColumn("buildings", "country", { type: DataTypes.STRING(2), allowNull: false, defaultValue: "AE" }));
  await step(() => qi.addColumn("buildings", "location_id", uuid()));
  await step(() => qi.addColumn("buildings", "latitude", { type: DataTypes.DECIMAL(10, 7), allowNull: true }));
  await step(() => qi.addColumn("buildings", "longitude", { type: DataTypes.DECIMAL(10, 7), allowNull: true }));

  await step(() => sequelize.query("ALTER TABLE units MODIFY COLUMN type ENUM('apartment','villa','townhouse','penthouse','office','retail','land','duplex','hotel_apartment','studio','compound','full_floor','half_floor','whole_building','bulk_units','warehouse','showroom','labour_camp','factory','farm','staff_accommodation') NOT NULL"));
  await step(() => qi.addColumn("units", "plot_area_sqft", { type: DataTypes.DECIMAL(12, 2), allowNull: true }));

  await step(() => qi.addColumn("listings", "completion_status", { type: DataTypes.ENUM("ready", "off_plan"), allowNull: true }));
  await step(() => qi.addColumn("listings", "ownership", { type: DataTypes.ENUM("freehold", "leasehold", "usufruct", "musataha"), allowNull: true }));
  await step(() => qi.addColumn("listings", "year_built", { type: DataTypes.INTEGER, allowNull: true }));
  await step(() => qi.addColumn("listings", "available_from", { type: DataTypes.DATEONLY, allowNull: true }));
  await step(() => qi.addColumn("listings", "utilities_included", { type: DataTypes.BOOLEAN, allowNull: true }));
}

export async function down({ context: qi, sequelize }: Ctx) {
  for (const c of ["utilities_included", "available_from", "year_built", "ownership", "completion_status"]) await step(() => qi.removeColumn("listings", c));
  await step(() => qi.removeColumn("units", "plot_area_sqft"));
  await step(() => sequelize.query("UPDATE units SET type='apartment' WHERE type NOT IN ('apartment','villa','townhouse','penthouse','office','retail','land')"));
  await step(() => sequelize.query("ALTER TABLE units MODIFY COLUMN type ENUM('apartment','villa','townhouse','penthouse','office','retail','land') NOT NULL"));
  for (const c of ["longitude", "latitude", "location_id", "country", "sub_community"]) await step(() => qi.removeColumn("buildings", c));
  await qi.dropTable("locations");
}
