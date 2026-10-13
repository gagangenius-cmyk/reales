import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid } from "./_helpers";

export async function up({ context: qi }: Ctx) {
  await qi.createTable("business_units", {
    id: id(), tenant_id: tenantId(), name: str(180),
    type: { type: DataTypes.ENUM("brokerage", "property_management", "developer"), allowNull: false }, ...ts(),
  });
  await qi.addIndex("business_units", ["tenant_id", "type"], { name: "ix_bu_tenant_type" });

  await qi.createTable("branches", {
    id: id(), tenant_id: tenantId(),
    business_unit_id: { ...uuid(false), references: { model: "business_units", key: "id" } },
    name: str(180), city: str(80, true), ...ts(),
  });
  await qi.addIndex("branches", ["tenant_id", "business_unit_id"], { name: "ix_branches_tenant_bu" });

  await qi.createTable("teams", {
    id: id(), tenant_id: tenantId(), branch_id: { ...uuid(), references: { model: "branches", key: "id" } }, name: str(180), ...ts(),
  });
  await qi.addIndex("teams", ["tenant_id", "branch_id"], { name: "ix_teams_tenant_branch" });

  await qi.createTable("team_members", {
    id: id(), tenant_id: tenantId(),
    team_id: { ...uuid(false), references: { model: "teams", key: "id" }, onDelete: "CASCADE" },
    user_id: { ...uuid(false), references: { model: "users", key: "id" }, onDelete: "CASCADE" }, ...ts(),
  });
  await qi.addIndex("team_members", ["tenant_id", "team_id", "user_id"], { unique: true, name: "uq_team_members" });
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["team_members", "teams", "branches", "business_units"]) await qi.dropTable(t);
}
