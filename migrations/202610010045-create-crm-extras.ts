import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  const money = (allowNull = false) => ({ type: DataTypes.DECIMAL(18, 2), allowNull });

  // Saved searches: a buyer/tenant requirement kept as criteria; new matching listings alert the owner.
  await qi.createTable("saved_searches", {
    id: id(), tenant_id: tenantId(), name: str(160), owner_user_id: uuid(false), contact_id: uuid(), lead_id: uuid(), criteria: json(false),
    notify: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, status: { type: DataTypes.ENUM("active", "paused"), allowNull: false, defaultValue: "active" }, last_run_at: dt(), ...ts(),
  });
  await tenantKey(qi, "saved_searches");
  await qi.addIndex("saved_searches", ["tenant_id", "owner_user_id", "status"], { name: "ix_saved_searches_owner" });
  await tenantFk(sequelize, "saved_searches", "owner_user_id", "users");
  await tenantFk(sequelize, "saved_searches", "contact_id", "contacts");
  await tenantFk(sequelize, "saved_searches", "lead_id", "leads");

  // Lead <-> listing matches (unique per pair so alerts fire once).
  await qi.createTable("property_matches", {
    id: id(), tenant_id: tenantId(), lead_id: uuid(false), listing_id: uuid(false), score: { type: DataTypes.INTEGER, allowNull: false }, reasons: json(false),
    status: { type: DataTypes.ENUM("new", "shared", "dismissed"), allowNull: false, defaultValue: "new" }, ...ts(),
  });
  await qi.addIndex("property_matches", ["tenant_id", "lead_id", "listing_id"], { unique: true, name: "uq_property_match" });
  await qi.addIndex("property_matches", ["tenant_id", "listing_id", "score"], { name: "ix_property_match_listing" });
  await tenantFk(sequelize, "property_matches", "lead_id", "leads");
  await tenantFk(sequelize, "property_matches", "listing_id", "listings");

  // In-app notifications (a unique dedupe key makes sweeps idempotent).
  await qi.createTable("notifications", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false), kind: str(40), title: str(200), body: str(500, true), entity_type: str(40, true), entity_id: uuid(), dedupe_key: str(120, true),
    read_at: dt(), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("notifications", ["tenant_id", "user_id", "read_at", "created_at"], { name: "ix_notifications_user" });
  await qi.addIndex("notifications", ["tenant_id", "user_id", "dedupe_key"], { unique: true, name: "uq_notification_dedupe" });
  await tenantFk(sequelize, "notifications", "user_id", "users");

  // Referral partners and referred leads.
  await qi.createTable("referral_partners", {
    id: id(), tenant_id: tenantId(), name: str(160), kind: { type: DataTypes.ENUM("broker", "developer", "bank", "corporate", "individual"), allowNull: false }, contact_id: uuid(),
    fee_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false }, status: { type: DataTypes.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" }, ...ts(),
  });
  await tenantKey(qi, "referral_partners");
  await qi.addIndex("referral_partners", ["tenant_id", "name"], { unique: true, name: "uq_referral_partner_name" });
  await tenantFk(sequelize, "referral_partners", "contact_id", "contacts");

  await qi.createTable("referrals", {
    id: id(), tenant_id: tenantId(), partner_id: uuid(false), lead_id: uuid(false), deal_id: uuid(), fee_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
    status: { type: DataTypes.ENUM("submitted", "won", "paid", "void"), allowNull: false, defaultValue: "submitted" }, fee_amount: money(true), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    settled_at: dt(), paid_at: dt(), note: str(500, true), ...ts(),
  });
  await tenantKey(qi, "referrals");
  await qi.addIndex("referrals", ["tenant_id", "lead_id"], { unique: true, name: "uq_referral_lead" });
  await qi.addIndex("referrals", ["tenant_id", "partner_id", "status"], { name: "ix_referrals_partner" });
  await tenantFk(sequelize, "referrals", "partner_id", "referral_partners");
  await tenantFk(sequelize, "referrals", "lead_id", "leads");
  await tenantFk(sequelize, "referrals", "deal_id", "deals");

  // Valuations (comparable-sales estimates), kept so a quoted price can be explained later.
  await qi.createTable("valuations", {
    id: id(), tenant_id: tenantId(), unit_id: uuid(false), estimate: money(), low: money(), high: money(), price_per_sqft: money(), confidence: { type: DataTypes.ENUM("low", "medium", "high"), allowNull: false },
    comps: json(false), method: str(80), created_by: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("valuations", ["tenant_id", "unit_id", "created_at"], { name: "ix_valuations_unit" });
  await tenantFk(sequelize, "valuations", "unit_id", "units");
}

export async function down({ context: qi }: Ctx) {
  for (const t of ["valuations", "referrals", "referral_partners", "notifications", "property_matches", "saved_searches"]) await qi.dropTable(t);
}
