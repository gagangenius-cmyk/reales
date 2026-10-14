import { DataTypes } from "sequelize";
import { Ctx } from "./_helpers";

/** Marketing attribution (free-text campaign name) and a "hot lead" flag on leads. */
export async function up({ context: qi }: Ctx) {
  await qi.addColumn("leads", "is_hot", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await qi.addColumn("leads", "campaign", { type: DataTypes.STRING(160), allowNull: true });
  await qi.addIndex("leads", ["tenant_id", "is_hot", "status"], { name: "ix_leads_tenant_hot_status" });
}

export async function down({ context: qi }: Ctx) {
  await qi.removeIndex("leads", "ix_leads_tenant_hot_status");
  await qi.removeColumn("leads", "campaign");
  await qi.removeColumn("leads", "is_hot");
}
