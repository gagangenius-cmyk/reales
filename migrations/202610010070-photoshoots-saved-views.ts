import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, json, dt, tenantKey, tenantFk, step } from "./_helpers";

/** Photoshoot requests for listings (request, schedule, shoot, deliver) and per-person saved list views (filters + column choice). */
export async function up({ context: qi, sequelize }: Ctx) {
  await step(() => qi.createTable("photoshoot_requests", {
    id: id(), tenant_id: tenantId(), listing_id: uuid(false), requested_by: uuid(false),
    status: { type: DataTypes.ENUM("requested", "scheduled", "in_progress", "delivered", "cancelled"), allowNull: false, defaultValue: "requested" },
    shoot_types: json(false), preferred_date: { type: DataTypes.DATEONLY, allowNull: true },
    scheduled_at: dt(), duration_minutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 120 },
    photographer_user_id: uuid(), photographer_name: str(120, true),
    access_contact_name: str(120, true), access_contact_phone: str(40, true), access_notes: str(500, true), notes: str(1000, true),
    started_at: dt(), delivered_at: dt(), delivered_by: uuid(), delivered_note: str(500, true), media_count: { type: DataTypes.INTEGER, allowNull: true },
    cancelled_by: uuid(), cancel_reason: str(255, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "photoshoot_requests"));
  await step(() => tenantFk(sequelize, "photoshoot_requests", "listing_id", "listings"));
  await step(() => qi.addIndex("photoshoot_requests", ["tenant_id", "status", "scheduled_at"], { name: "ix_photoshoot_status" }));
  await step(() => qi.addIndex("photoshoot_requests", ["tenant_id", "listing_id"], { name: "ix_photoshoot_listing" }));
  await step(() => qi.addIndex("photoshoot_requests", ["tenant_id", "photographer_user_id", "scheduled_at"], { name: "ix_photoshoot_photographer" }));

  await step(() => qi.createTable("saved_views", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false), entity: { type: DataTypes.ENUM("leads", "listings", "contacts", "deals"), allowNull: false },
    name: str(80), filters: json(false), columns: json(), sort: str(40, true),
    shared: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, ...ts(),
  }));
  await step(() => tenantKey(qi, "saved_views"));
  await step(() => qi.addIndex("saved_views", ["tenant_id", "user_id", "entity", "name"], { unique: true, name: "uq_saved_views_name" }));
  await step(() => qi.addIndex("saved_views", ["tenant_id", "entity", "shared"], { name: "ix_saved_views_shared" }));
}
export async function down({ context: qi }: Ctx) {
  await qi.dropTable("saved_views");
  await qi.dropTable("photoshoot_requests");
}
