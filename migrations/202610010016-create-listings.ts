import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  // Compliance tables come first so listings can reference them (blueprint migration 017 content).
  await qi.createTable("broker_licences", {
    id: id(), tenant_id: tenantId(), holder_type: { type: DataTypes.ENUM("company", "agent"), allowNull: false },
    holder_name: str(180), user_id: uuid(), licence_no: str(80), authority: str(60),
    issued_at: { type: DataTypes.DATEONLY, allowNull: true }, expires_at: { type: DataTypes.DATEONLY, allowNull: false },
    validation_status: { type: DataTypes.ENUM("unverified", "valid", "revoked"), allowNull: false, defaultValue: "unverified" },
    verified_at: { type: DataTypes.DATE(3), allowNull: true }, verified_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "broker_licences");
  await qi.addIndex("broker_licences", ["tenant_id", "authority", "licence_no"], { unique: true, name: "uq_broker_licences" });
  await tenantFk(sequelize, "broker_licences", "user_id", "users");

  await qi.createTable("listings", {
    id: id(), tenant_id: tenantId(), unit_id: uuid(false),
    purpose: { type: DataTypes.ENUM("sale", "rent"), allowNull: false },
    status: { type: DataTypes.ENUM("draft", "published", "unpublished"), allowNull: false, defaultValue: "draft" },
    title: str(255, true), description: { type: DataTypes.TEXT, allowNull: true },
    price: { type: DataTypes.DECIMAL(18, 2), allowNull: true }, currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    agent_user_id: uuid(), branch_id: uuid(), project_id: uuid(), jurisdiction_code: str(40), broker_licence_id: uuid(),
    published_at: { type: DataTypes.DATE(3), allowNull: true }, ...ts(),
  });
  await tenantKey(qi, "listings");
  await qi.addIndex("listings", ["tenant_id", "status", "purpose"], { name: "ix_listings_tenant_status_purpose" });
  await qi.addIndex("listings", ["tenant_id", "agent_user_id", "status"], { name: "ix_listings_tenant_agent" });
  await qi.addIndex("listings", ["tenant_id", "unit_id"], { name: "ix_listings_tenant_unit" });
  await tenantFk(sequelize, "listings", "unit_id", "units");
  await tenantFk(sequelize, "listings", "agent_user_id", "users");
  await tenantFk(sequelize, "listings", "branch_id", "branches");
  await tenantFk(sequelize, "listings", "project_id", "projects");
  await tenantFk(sequelize, "listings", "broker_licence_id", "broker_licences");

  await qi.createTable("listing_media", {
    id: id(), tenant_id: tenantId(), listing_id: uuid(false),
    kind: { type: DataTypes.ENUM("image", "video", "floorplan"), allowNull: false }, storage_key: str(500),
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, ...ts(),
  });
  await qi.addIndex("listing_media", ["tenant_id", "listing_id", "position"], { name: "ix_listing_media_listing" });
  await tenantFk(sequelize, "listing_media", "listing_id", "listings", "CASCADE");

  await qi.createTable("listing_prices", {
    id: id(), tenant_id: tenantId(), listing_id: uuid(false), price: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false }, changed_by: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("listing_prices", ["tenant_id", "listing_id", "created_at"], { name: "ix_listing_prices_listing" });
  await tenantFk(sequelize, "listing_prices", "listing_id", "listings");
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["listing_prices", "listing_media", "listings", "broker_licences"]) await qi.dropTable(t);
}
