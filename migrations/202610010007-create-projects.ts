import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid } from "./_helpers";

export async function up({ context: qi }: Ctx) {
  await qi.createTable("projects", {
    id: id(), tenant_id: tenantId(),
    business_unit_id: { ...uuid(), references: { model: "business_units", key: "id" } },
    kind: { type: DataTypes.ENUM("project", "portfolio", "workspace"), allowNull: false, defaultValue: "project" },
    code: str(40), name: str(180),
    status: { type: DataTypes.ENUM("active", "archived"), allowNull: false, defaultValue: "active" }, ...ts(),
  });
  await qi.addIndex("projects", ["tenant_id", "code"], { unique: true, name: "uq_projects_tenant_code" });
  await qi.addIndex("projects", ["tenant_id", "status"], { name: "ix_projects_tenant_status" });
}
export async function down({ context: qi }: Ctx) { await qi.dropTable("projects"); }
