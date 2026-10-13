import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, tenantKey } from "./_helpers";

export async function up({ context: qi }: Ctx) {
  await qi.createTable("developers", {
    id: id(), tenant_id: tenantId(), name: str(180), registration_no: str(80, true), jurisdiction_code: str(40),
    escrow_registered: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, ...ts(),
  });
  await tenantKey(qi, "developers");
  await qi.addIndex("developers", ["tenant_id", "name"], { name: "ix_developers_tenant_name" });
}
export async function down({ context: qi }: Ctx) { await qi.dropTable("developers"); }
