import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, json } from "./_helpers";

/** Platform-maintained (global) regulatory catalogue: requirements are data, never if-statements in UI code. */
export async function up({ context: qi }: Ctx) {
  await qi.createTable("jurisdictions", {
    id: id(), code: str(40), name: str(120), emirate: str(40), registration_authority: str(60), tenancy_authority: str(60, true), ...ts(),
  });
  await qi.addIndex("jurisdictions", ["code"], { unique: true, name: "uq_jurisdictions_code" });

  await qi.createTable("regulatory_rules", {
    id: id(), jurisdiction_id: { type: DataTypes.UUID, allowNull: false, references: { model: "jurisdictions", key: "id" } },
    code: str(80), description: str(500, true), ...ts(),
  });
  await qi.addIndex("regulatory_rules", ["jurisdiction_id", "code"], { unique: true, name: "uq_regulatory_rules_code" });

  await qi.createTable("regulatory_rule_versions", {
    id: id(), rule_id: { type: DataTypes.UUID, allowNull: false, references: { model: "regulatory_rules", key: "id" } },
    version: { type: DataTypes.INTEGER, allowNull: false }, effective_from: { type: DataTypes.DATEONLY, allowNull: false },
    effective_to: { type: DataTypes.DATEONLY, allowNull: true }, definition: json(false), ...ts(),
  });
  await qi.addIndex("regulatory_rule_versions", ["rule_id", "version"], { unique: true, name: "uq_rule_versions" });
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["regulatory_rule_versions", "regulatory_rules", "jurisdictions"]) await qi.dropTable(t);
}
