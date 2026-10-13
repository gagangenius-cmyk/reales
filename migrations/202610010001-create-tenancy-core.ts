import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, json } from "./_helpers";

export async function up({ context: qi }: Ctx) {
  await qi.createTable("tenants", {
    id: id(), name: str(180), slug: str(100),
    status: { type: DataTypes.ENUM("active", "suspended"), allowNull: false, defaultValue: "active" },
    data_region: str(32), // e.g. "ae-uae"
    jurisdiction: str(40), // e.g. DUBAI_MAINLAND, ADGM (blueprint: jurisdiction is first-class data)
    country: { type: DataTypes.STRING(2), allowNull: false, defaultValue: "AE" },
    ...ts(),
  });
  await qi.addIndex("tenants", ["slug"], { unique: true, name: "uq_tenants_slug" });

  await qi.createTable("tenant_settings", {
    id: id(), tenant_id: tenantId(), key: str(120), value: json(), ...ts(),
  });
  await qi.addIndex("tenant_settings", ["tenant_id", "key"], { unique: true, name: "uq_tenant_settings_key" });
}
export async function down({ context: qi }: Ctx) {
  await qi.dropTable("tenant_settings");
  await qi.dropTable("tenants");
}
