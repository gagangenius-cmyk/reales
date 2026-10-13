import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, json, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("templates", {
    id: id(), tenant_id: tenantId(), project_id: uuid(),
    channel: { type: DataTypes.ENUM("email", "whatsapp", "sms"), allowNull: false },
    name: str(160), purpose: str(60, true), // maps to a consent purpose code
    status: { type: DataTypes.ENUM("draft", "approved", "archived"), allowNull: false, defaultValue: "draft" },
    current_version_id: uuid(), created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "templates");
  await qi.addIndex("templates", ["tenant_id", "channel", "status"], { name: "ix_templates_channel_status" });
  await qi.addIndex("templates", ["tenant_id", "name"], { unique: true, name: "uq_templates_name" });
  await tenantFk(sequelize, "templates", "project_id", "projects");

  // Immutable: an edit creates a new version; sent messages keep pointing at the exact version they used.
  await qi.createTable("template_versions", {
    id: id(), tenant_id: tenantId(), template_id: uuid(false), version: { type: DataTypes.INTEGER, allowNull: false },
    subject: str(255, true), design_json: json(), rendered_html: { type: DataTypes.TEXT("medium"), allowNull: true },
    text_body: { type: DataTypes.TEXT, allowNull: true }, structured_components_json: json(), variable_schema_json: json(),
    approval_status: { type: DataTypes.ENUM("not_required", "pending", "approved", "rejected"), allowNull: false, defaultValue: "not_required" },
    created_by: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await tenantKey(qi, "template_versions");
  await qi.addIndex("template_versions", ["tenant_id", "template_id", "version"], { unique: true, name: "uq_template_versions" });
  await tenantFk(sequelize, "template_versions", "template_id", "templates");
  await sequelize.query("CREATE TRIGGER template_versions_no_delete BEFORE DELETE ON template_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'template_versions is append-only'");
}
export async function down({ context: qi, sequelize }: Ctx) {
  await sequelize.query("DROP TRIGGER IF EXISTS template_versions_no_delete");
  await qi.dropTable("template_versions");
  await qi.dropTable("templates");
}
