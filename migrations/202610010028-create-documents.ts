import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, tenantKey, tenantFk } from "./_helpers";

async function appendOnly(sequelize: any, table: string) {
  await sequelize.query(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
  await sequelize.query(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
}
async function dropAppendOnly(sequelize: any, table: string) {
  await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_no_update`);
  await sequelize.query(`DROP TRIGGER IF EXISTS ${table}_no_delete`);
}

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("documents", {
    id: id(), tenant_id: tenantId(), title: str(255),
    kind: { type: DataTypes.ENUM("contract", "id_document", "permit", "invoice", "receipt", "other"), allowNull: false, defaultValue: "other" },
    current_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "documents");
  await qi.addIndex("documents", ["tenant_id", "kind"], { name: "ix_documents_kind" });

  // Versions are immutable evidence: content hash + storage key, never edited or deleted.
  await qi.createTable("document_versions", {
    id: id(), tenant_id: tenantId(), document_id: uuid(false), version: { type: DataTypes.INTEGER, allowNull: false },
    storage_key: str(500), filename: str(255), mime: str(100), size_bytes: { type: DataTypes.BIGINT, allowNull: false }, content_hash: str(64),
    created_by: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("document_versions", ["tenant_id", "document_id", "version"], { unique: true, name: "uq_document_versions" });
  await tenantFk(sequelize, "document_versions", "document_id", "documents");
  await appendOnly(sequelize, "document_versions");

  await qi.createTable("document_links", {
    id: id(), tenant_id: tenantId(), document_id: uuid(false), entity_type: str(40), entity_id: uuid(false), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("document_links", ["tenant_id", "entity_type", "entity_id"], { name: "ix_document_links_entity" });
  await qi.addIndex("document_links", ["tenant_id", "document_id", "entity_type", "entity_id"], { unique: true, name: "uq_document_links" });
  await tenantFk(sequelize, "document_links", "document_id", "documents", "CASCADE");
}
export async function down({ context: qi, sequelize }: Ctx) {
  await dropAppendOnly(sequelize, "document_versions");
  for (const t of ["document_links", "document_versions", "documents"]) await qi.dropTable(t);
}
