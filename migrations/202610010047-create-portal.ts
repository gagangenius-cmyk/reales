import { DataTypes } from "sequelize";
import { Ctx, id, ts, tenantId, uuid, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  // A portal login (a normal user with the minimal "portal_user" role) is bound to ONE contact; every portal query filters by that link, never by CRM scopes.
  await qi.createTable("portal_links", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false), contact_id: uuid(false), kind: { type: DataTypes.ENUM("owner", "tenant"), allowNull: false },
    status: { type: DataTypes.ENUM("active", "revoked"), allowNull: false, defaultValue: "active" }, ...ts(),
  });
  await qi.addIndex("portal_links", ["tenant_id", "user_id"], { unique: true, name: "uq_portal_user" });
  await qi.addIndex("portal_links", ["tenant_id", "contact_id"], { name: "ix_portal_contact" });
  await tenantFk(sequelize, "portal_links", "user_id", "users");
  await tenantFk(sequelize, "portal_links", "contact_id", "contacts");
}
export async function down({ context: qi }: Ctx) { await qi.dropTable("portal_links"); }
