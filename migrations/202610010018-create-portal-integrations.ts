import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, json, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("portal_accounts", {
    id: id(), tenant_id: tenantId(), provider: str(40), name: str(120),
    mode: { type: DataTypes.ENUM("export", "api"), allowNull: false, defaultValue: "export" },
    config: json(), // non-secret settings only; credentials belong in the secrets manager
    status: { type: DataTypes.ENUM("active", "disabled"), allowNull: false, defaultValue: "active" }, ...ts(),
  });
  await tenantKey(qi, "portal_accounts");
  await qi.addIndex("portal_accounts", ["tenant_id", "provider"], { name: "ix_portal_accounts_provider" });

  // Append-only: every publish/unpublish writes a new immutable snapshot ("what did we send at 14:32?").
  await qi.createTable("portal_publications", {
    id: id(), tenant_id: tenantId(), listing_id: uuid(false), portal_account_id: uuid(false),
    action: { type: DataTypes.ENUM("publish", "update", "unpublish"), allowNull: false },
    status: { type: DataTypes.ENUM("exported", "sent", "failed"), allowNull: false },
    snapshot: json(false), snapshot_hash: str(64), payload_format: str(20, true), payload: { type: DataTypes.TEXT("medium"), allowNull: true },
    external_ref: str(120, true), error: { type: DataTypes.TEXT, allowNull: true }, actor_id: str(64, true),
    created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("portal_publications", ["tenant_id", "listing_id", "created_at"], { name: "ix_portal_publications_listing" });
  await tenantFk(sequelize, "portal_publications", "listing_id", "listings");
  await tenantFk(sequelize, "portal_publications", "portal_account_id", "portal_accounts");
  await sequelize.query("CREATE TRIGGER portal_publications_no_update BEFORE UPDATE ON portal_publications FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'portal_publications is append-only'");
  await sequelize.query("CREATE TRIGGER portal_publications_no_delete BEFORE DELETE ON portal_publications FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'portal_publications is append-only'");

  await qi.createTable("portal_sync_logs", {
    id: id(), tenant_id: tenantId(), portal_account_id: uuid(false), listing_id: uuid(), action: str(40), outcome: str(20), detail: str(500, true),
    created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("portal_sync_logs", ["tenant_id", "portal_account_id", "created_at"], { name: "ix_portal_sync_logs_account" });
  await tenantFk(sequelize, "portal_sync_logs", "portal_account_id", "portal_accounts");
}
export async function down({ context: qi, sequelize }: Ctx) {
  await sequelize.query("DROP TRIGGER IF EXISTS portal_publications_no_update");
  await sequelize.query("DROP TRIGGER IF EXISTS portal_publications_no_delete");
  for (const t of ["portal_sync_logs", "portal_publications", "portal_accounts"]) await qi.dropTable(t);
}
