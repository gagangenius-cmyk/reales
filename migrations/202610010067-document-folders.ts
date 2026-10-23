import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, json, tenantKey, step } from "./_helpers";

/** Document folders with policies: who may open them, a default expiry, a retention period that blocks deletion, allowed kinds, and whether a link to a record is required. */
export async function up({ context: qi }: Ctx) {
  await step(() => qi.createTable("document_folders", {
    id: id(), tenant_id: tenantId(), name: str(120), description: str(300, true), restricted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    default_expiry_days: { type: DataTypes.INTEGER, allowNull: true }, retention_days: { type: DataTypes.INTEGER, allowNull: true }, allowed_kinds: json(),
    requires_link: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, created_by: uuid(), ...ts(),
  }));
  await step(() => tenantKey(qi, "document_folders"));
  await step(() => qi.addIndex("document_folders", ["tenant_id", "name"], { unique: true, name: "uq_document_folders_name" }));
  await step(() => qi.addColumn("documents", "folder_id", uuid()));
  await step(() => qi.addColumn("documents", "expires_on", { type: DataTypes.DATEONLY, allowNull: true }));
  await step(() => qi.addColumn("documents", "retain_until", { type: DataTypes.DATEONLY, allowNull: true }));
  await step(() => qi.addIndex("documents", ["tenant_id", "folder_id"], { name: "ix_documents_folder" }));
  await step(() => qi.addIndex("documents", ["tenant_id", "expires_on"], { name: "ix_documents_expiry" }));
}
export async function down({ context: qi }: Ctx) {
  for (const c of ["retain_until", "expires_on", "folder_id"]) await step(() => qi.removeColumn("documents", c));
  await qi.dropTable("document_folders");
}
