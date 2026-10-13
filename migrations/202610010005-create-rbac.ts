import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid } from "./_helpers";

export async function up({ context: qi }: Ctx) {
  await qi.createTable("permissions", { id: id(), key: str(100), description: str(255, true), ...ts() });
  await qi.addIndex("permissions", ["key"], { unique: true, name: "uq_permissions_key" });

  await qi.createTable("roles", {
    id: id(), tenant_id: tenantId(), key: str(60), name: str(120),
    is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    requires_mfa: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, ...ts(),
  });
  await qi.addIndex("roles", ["tenant_id", "key"], { unique: true, name: "uq_roles_tenant_key" });

  await qi.createTable("role_permissions", {
    id: id(), tenant_id: tenantId(),
    role_id: { ...uuid(false), references: { model: "roles", key: "id" }, onDelete: "CASCADE" },
    permission_id: { ...uuid(false), references: { model: "permissions", key: "id" } },
    scope: { type: DataTypes.ENUM("tenant", "business_unit", "branch", "project", "portfolio", "own_records"), allowNull: false },
    ...ts(),
  });
  await qi.addIndex("role_permissions", ["tenant_id", "role_id"], { name: "ix_role_permissions_role" });
  await qi.addIndex("role_permissions", ["role_id", "permission_id", "scope"], { unique: true, name: "uq_role_permission_scope" });

  await qi.createTable("user_roles", {
    id: id(), tenant_id: tenantId(),
    user_id: { ...uuid(false), references: { model: "users", key: "id" }, onDelete: "CASCADE" },
    role_id: { ...uuid(false), references: { model: "roles", key: "id" }, onDelete: "CASCADE" },
    // Optional anchor restricts a role's scoped grants to one project/branch/etc (e.g. listing.publish on project A).
    anchor_type: { type: DataTypes.ENUM("business_unit", "branch", "project", "portfolio"), allowNull: true },
    anchor_id: uuid(), ...ts(),
  });
  await qi.addIndex("user_roles", ["tenant_id", "user_id"], { name: "ix_user_roles_user" });
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["user_roles", "role_permissions", "roles", "permissions"]) await qi.dropTable(t);
}
