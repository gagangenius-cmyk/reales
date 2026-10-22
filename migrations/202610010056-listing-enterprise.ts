import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk, step } from "./_helpers";

/**
 * Enterprise listing detail: a human reference, marketing attributes (features, furnishing, parking, rent terms), exclusivity and owner terms,
 * lifecycle dates (expiry, refresh), a shareable public page with its own token and counters, a cover photo, and an enquiry log that ties
 * website enquiries back to the listing.
 */
export async function up({ context: qi, sequelize }: Ctx) {
  const col = (name: string, def: Parameters<typeof qi.addColumn>[2]) => step(() => qi.addColumn("listings", name, def));
  await col("reference", str(30, true));
  await col("features", { type: DataTypes.JSON, allowNull: true });
  await col("furnishing", { type: DataTypes.ENUM("unfurnished", "semi_furnished", "furnished"), allowNull: true });
  await col("parking_spaces", { type: DataTypes.INTEGER, allowNull: true });
  await col("rent_frequency", { type: DataTypes.ENUM("yearly", "quarterly", "monthly"), allowNull: true });
  await col("cheques", { type: DataTypes.INTEGER, allowNull: true });
  await col("security_deposit", { type: DataTypes.DECIMAL(18, 2), allowNull: true });
  await col("service_charge", { type: DataTypes.DECIMAL(18, 2), allowNull: true });
  await col("video_url", str(300, true));
  await col("virtual_tour_url", str(300, true));
  await col("title_ar", str(255, true));
  await col("description_ar", { type: DataTypes.TEXT, allowNull: true });
  await col("exclusivity", { type: DataTypes.ENUM("none", "exclusive", "non_exclusive"), allowNull: false, defaultValue: "none" });
  await col("agreement_starts_on", { type: DataTypes.DATEONLY, allowNull: true });
  await col("agreement_expires_on", { type: DataTypes.DATEONLY, allowNull: true });
  await col("owner_price", { type: DataTypes.DECIMAL(18, 2), allowNull: true });
  await col("commission_pct", { type: DataTypes.DECIMAL(5, 2), allowNull: true });
  await col("featured", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await col("expires_on", { type: DataTypes.DATEONLY, allowNull: true });
  await col("last_refreshed_at", dt());
  await col("share_token", str(40, true));
  await col("share_enabled", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await col("view_count", { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  await col("enquiry_count", { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  await col("latitude", { type: DataTypes.DECIMAL(9, 6), allowNull: true });
  await col("longitude", { type: DataTypes.DECIMAL(9, 6), allowNull: true });
  await col("cover_media_id", uuid());
  await step(() => qi.addIndex("listings", ["tenant_id", "reference"], { unique: true, name: "uq_listings_reference" }));
  await step(() => qi.addIndex("listings", ["share_token"], { unique: true, name: "uq_listings_share_token" }));
  await step(() => qi.addIndex("listings", ["tenant_id", "status", "expires_on"], { name: "ix_listings_expiry" }));

  const m = (name: string, def: Parameters<typeof qi.addColumn>[2]) => step(() => qi.addColumn("listing_media", name, def));
  await m("caption", str(200, true));
  await m("file_name", str(200, true));
  await m("mime", str(80, true));
  await m("size_bytes", { type: DataTypes.INTEGER, allowNull: true });

  await step(() => qi.createTable("listing_enquiries", {
    id: id(), tenant_id: tenantId(), listing_id: uuid(false), lead_id: uuid(), contact_id: uuid(),
    channel: { type: DataTypes.ENUM("web", "portal", "whatsapp", "phone", "other"), allowNull: false, defaultValue: "web" },
    message: { type: DataTypes.TEXT, allowNull: true }, duplicate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, ...ts(),
  }));
  await step(() => tenantKey(qi, "listing_enquiries"));
  await step(() => qi.addIndex("listing_enquiries", ["tenant_id", "listing_id", "created_at"], { name: "ix_listing_enquiries_listing" }));
  await step(() => tenantFk(sequelize, "listing_enquiries", "listing_id", "listings", "CASCADE"));
}

export async function down({ context: qi }: Ctx) {
  await qi.dropTable("listing_enquiries");
  for (const c of ["size_bytes", "mime", "file_name", "caption"]) await qi.removeColumn("listing_media", c);
  await qi.removeIndex("listings", "ix_listings_expiry");
  await qi.removeIndex("listings", "uq_listings_share_token");
  await qi.removeIndex("listings", "uq_listings_reference");
  for (const c of ["cover_media_id", "longitude", "latitude", "enquiry_count", "view_count", "share_enabled", "share_token", "last_refreshed_at", "expires_on", "featured", "commission_pct", "owner_price", "agreement_expires_on", "agreement_starts_on", "exclusivity", "description_ar", "title_ar", "virtual_tour_url", "video_url", "service_charge", "security_deposit", "cheques", "rent_frequency", "parking_spaces", "furnishing", "features", "reference"]) await qi.removeColumn("listings", c);
}
