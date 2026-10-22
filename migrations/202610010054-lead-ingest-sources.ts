import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk, step } from "./_helpers";

/**
 * Inbound lead endpoints (Meta lead forms via a connector, portals, website forms, any system that can POST JSON).
 * Each source has its own public id and signing secret (stored encrypted); every delivery is recorded and de-duplicated by the sender's id.
 */
export async function up({ context: qi, sequelize }: Ctx) {
  await step(() => qi.createTable("lead_ingest_sources", {
    id: id(), tenant_id: tenantId(), name: str(120), kind: { type: DataTypes.ENUM("meta", "portal", "website", "generic"), allowNull: false, defaultValue: "generic" },
    public_id: str(40), secret_enc: { type: DataTypes.TEXT, allowNull: false },
    source_code: str(60, true), project_id: uuid(), pool_id: uuid(), route_mode: { type: DataTypes.ENUM("rules", "pool"), allowNull: false, defaultValue: "rules" },
    default_purpose: { type: DataTypes.ENUM("buy", "rent", "invest", "off_plan"), allowNull: false, defaultValue: "buy" }, campaign: str(160, true),
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    total_received: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, last_received_at: dt(), created_by: str(64, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "lead_ingest_sources"));
  await step(() => qi.addIndex("lead_ingest_sources", ["public_id"], { unique: true, name: "uq_lead_ingest_public_id" }));
  await step(() => tenantFk(sequelize, "lead_ingest_sources", "pool_id", "lead_pools"));

  await step(() => qi.createTable("lead_ingest_events", {
    id: id(), tenant_id: tenantId(), source_id: uuid(false), external_id: str(160),
    status: { type: DataTypes.ENUM("created", "duplicate", "rejected"), allowNull: false }, lead_id: uuid(), error: str(255, true), received_at: { type: DataTypes.DATE(3), allowNull: false }, ...ts(),
  }));
  await step(() => tenantKey(qi, "lead_ingest_events"));
  await step(() => qi.addIndex("lead_ingest_events", ["tenant_id", "source_id", "external_id"], { unique: true, name: "uq_lead_ingest_event_external" }));
  await step(() => qi.addIndex("lead_ingest_events", ["tenant_id", "source_id", "received_at"], { name: "ix_lead_ingest_events_recent" }));
  await step(() => tenantFk(sequelize, "lead_ingest_events", "source_id", "lead_ingest_sources", "CASCADE"));
}

export async function down({ context: qi }: Ctx) {
  await qi.dropTable("lead_ingest_events");
  await qi.dropTable("lead_ingest_sources");
}
