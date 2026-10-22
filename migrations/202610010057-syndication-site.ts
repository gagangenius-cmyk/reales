import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk, step } from "./_helpers";

/**
 * Listing distribution and the public property website.
 *  - listing_channels: per listing, which channels it is on (the public website, each portal account), with the portal's own id, last sync result and error;
 *  - portal_accounts: an unguessable feed token (portals such as Bayut pull a feed from a public URL), encrypted credentials and the last connection test;
 *  - site_settings: the tenant's public website (branding, contact details, language, SEO).
 */
export async function up({ context: qi, sequelize }: Ctx) {
  await step(() => qi.createTable("listing_channels", {
    id: id(), tenant_id: tenantId(), listing_id: uuid(false),
    channel_kind: { type: DataTypes.ENUM("website", "portal"), allowNull: false }, portal_account_id: uuid(),
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    external_id: str(120, true), external_url: str(400, true), pending_publication_id: uuid(), last_synced_at: dt(), last_status: str(20, true), last_error: str(500, true), attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, ...ts(),
  }));
  await step(() => tenantKey(qi, "listing_channels"));
  await step(() => qi.addIndex("listing_channels", ["tenant_id", "listing_id", "channel_kind", "portal_account_id"], { unique: true, name: "uq_listing_channels" }));
  await step(() => tenantFk(sequelize, "listing_channels", "listing_id", "listings", "CASCADE"));
  await step(() => tenantFk(sequelize, "listing_channels", "portal_account_id", "portal_accounts"));

  // portal_publications is append-only history; the work queue lives on listing_channels (last_status queued/retry + pending_publication_id).
  await sequelize.query("ALTER TABLE portal_publications MODIFY COLUMN status ENUM('exported','sent','failed','queued') NOT NULL");
  await step(() => qi.addColumn("portal_accounts", "feed_token", str(48, true)));
  await step(() => qi.addColumn("portal_accounts", "credentials_enc", { type: DataTypes.TEXT, allowNull: true }));
  await step(() => qi.addColumn("portal_accounts", "last_tested_at", dt()));
  await step(() => qi.addColumn("portal_accounts", "last_test_ok", { type: DataTypes.BOOLEAN, allowNull: true }));
  await step(() => qi.addColumn("portal_accounts", "last_test_message", str(300, true)));
  await step(() => qi.addIndex("portal_accounts", ["feed_token"], { unique: true, name: "uq_portal_accounts_feed_token" }));

  await step(() => qi.createTable("site_settings", {
    id: id(), tenant_id: tenantId(), enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    title: str(120, true), tagline: str(200, true), about: { type: DataTypes.TEXT, allowNull: true }, phone: str(40, true), whatsapp: str(40, true), email: str(254, true), address: str(255, true),
    logo_url: str(400, true), primary_color: str(9, true), default_language: { type: DataTypes.ENUM("en", "ar"), allowNull: false, defaultValue: "en" },
    show_prices: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, area_unit: { type: DataTypes.ENUM("sqft", "sqm"), allowNull: false, defaultValue: "sqft" },
    seo_description: str(300, true), social: json(), ...ts(),
  }));
  await step(() => tenantKey(qi, "site_settings"));
  await step(() => qi.addIndex("site_settings", ["tenant_id"], { unique: true, name: "uq_site_settings_tenant" }));
}

export async function down({ context: qi }: Ctx) {
  await qi.dropTable("site_settings");
  await qi.removeIndex("portal_accounts", "uq_portal_accounts_feed_token");
  for (const c of ["last_test_message", "last_test_ok", "last_tested_at", "credentials_enc", "feed_token"]) await qi.removeColumn("portal_accounts", c);
  await qi.dropTable("listing_channels");
}
