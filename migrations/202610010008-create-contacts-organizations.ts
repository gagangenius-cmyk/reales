import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("organizations", {
    id: id(), tenant_id: tenantId(), name: str(180), trade_licence_no: str(80, true), licence_authority: str(80, true),
    country: { type: DataTypes.STRING(2), allowNull: false, defaultValue: "AE" }, ...ts(),
  });
  await tenantKey(qi, "organizations");
  await qi.addIndex("organizations", ["tenant_id", "name"], { name: "ix_organizations_tenant_name" });

  await qi.createTable("contacts", {
    id: id(), tenant_id: tenantId(),
    type: { type: DataTypes.ENUM("person", "company"), allowNull: false, defaultValue: "person" },
    first_name: str(120, true), last_name: str(120, true), company_name: str(180, true),
    email: str(254, true), normalized_email: str(254, true), phone_e164: str(32, true),
    language: { type: DataTypes.STRING(10), allowNull: true }, nationality: str(60, true),
    organization_id: uuid(), owner_user_id: uuid(), branch_id: uuid(),
    status: { type: DataTypes.ENUM("active", "archived"), allowNull: false, defaultValue: "active" }, ...ts(),
  });
  await tenantKey(qi, "contacts");
  await qi.addIndex("contacts", ["tenant_id", "normalized_email"], { name: "ix_contacts_tenant_email" });
  await qi.addIndex("contacts", ["tenant_id", "phone_e164"], { name: "ix_contacts_tenant_phone" });
  await qi.addIndex("contacts", ["tenant_id", "owner_user_id"], { name: "ix_contacts_tenant_owner" });
  await qi.addIndex("contacts", ["tenant_id", "branch_id"], { name: "ix_contacts_tenant_branch" });
  await tenantFk(sequelize, "contacts", "organization_id", "organizations");
  await tenantFk(sequelize, "contacts", "owner_user_id", "users");
  await tenantFk(sequelize, "contacts", "branch_id", "branches");
}
export async function down({ context: qi }: Ctx) {
  await qi.dropTable("contacts");
  await qi.dropTable("organizations");
}
