import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("listing_permits", {
    id: id(), tenant_id: tenantId(), listing_id: uuid(false), permit_no: str(80), authority: str(60),
    issued_at: { type: DataTypes.DATEONLY, allowNull: true }, expires_at: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM("pending", "valid", "revoked", "rejected"), allowNull: false, defaultValue: "pending" },
    source: { type: DataTypes.ENUM("manual", "api"), allowNull: false, defaultValue: "manual" },
    verified_at: { type: DataTypes.DATE(3), allowNull: true }, verified_by: str(64, true), ...ts(),
  });
  await qi.addIndex("listing_permits", ["tenant_id", "listing_id", "status"], { name: "ix_listing_permits_listing" });
  await qi.addIndex("listing_permits", ["tenant_id", "authority", "permit_no"], { unique: true, name: "uq_listing_permits_no" });
  await tenantFk(sequelize, "listing_permits", "listing_id", "listings");
}
export async function down({ context: qi }: Ctx) { await qi.dropTable("listing_permits"); }
