import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("workflows", {
    id: id(), tenant_id: tenantId(), project_id: uuid(), name: str(160),
    status: { type: DataTypes.ENUM("draft", "published", "disabled"), allowNull: false, defaultValue: "draft" },
    draft_graph: json(), // the editable React Flow canvas; never executed
    current_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, created_by: str(64, true), ...ts(),
  });
  await tenantKey(qi, "workflows");
  await qi.addIndex("workflows", ["tenant_id", "name"], { unique: true, name: "uq_workflows_name" });
  await qi.addIndex("workflows", ["tenant_id", "status"], { name: "ix_workflows_status" });
  await tenantFk(sequelize, "workflows", "project_id", "projects");

  // Published versions are immutable and are what runs.
  await qi.createTable("workflow_versions", {
    id: id(), tenant_id: tenantId(), workflow_id: uuid(false), version: { type: DataTypes.INTEGER, allowNull: false },
    graph: json(false), trigger_type: str(80), published_by: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await tenantKey(qi, "workflow_versions");
  await qi.addIndex("workflow_versions", ["tenant_id", "workflow_id", "version"], { unique: true, name: "uq_workflow_versions" });
  await qi.addIndex("workflow_versions", ["tenant_id", "trigger_type"], { name: "ix_workflow_versions_trigger" });
  await tenantFk(sequelize, "workflow_versions", "workflow_id", "workflows");
  await sequelize.query("CREATE TRIGGER workflow_versions_no_update BEFORE UPDATE ON workflow_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'workflow_versions is append-only'");
  await sequelize.query("CREATE TRIGGER workflow_versions_no_delete BEFORE DELETE ON workflow_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'workflow_versions is append-only'");

  await qi.createTable("workflow_runs", {
    id: id(), tenant_id: tenantId(), workflow_id: uuid(false), version_id: uuid(false), trigger_event_id: str(64), entity_type: str(40), entity_id: uuid(false),
    status: { type: DataTypes.ENUM("running", "waiting", "completed", "failed", "cancelled"), allowNull: false, defaultValue: "running" },
    context: json(), steps_executed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, error: str(500, true),
    started_at: { type: DataTypes.DATE(3), allowNull: false }, finished_at: dt(), ...ts(),
  });
  await tenantKey(qi, "workflow_runs");
  // A trigger event starts a workflow version at most once (event delivery is at-least-once).
  await qi.addIndex("workflow_runs", ["tenant_id", "version_id", "trigger_event_id"], { unique: true, name: "uq_workflow_run_trigger" });
  await qi.addIndex("workflow_runs", ["tenant_id", "status"], { name: "ix_workflow_runs_status" });
  await tenantFk(sequelize, "workflow_runs", "workflow_id", "workflows");
  await tenantFk(sequelize, "workflow_runs", "version_id", "workflow_versions");
  await tenantFk(sequelize, "messages", "workflow_run_id", "workflow_runs");

  await qi.createTable("workflow_steps", {
    id: id(), tenant_id: tenantId(), run_id: uuid(false), node_id: str(80), node_type: str(80),
    status: { type: DataTypes.ENUM("completed", "failed", "skipped"), allowNull: false }, output: json(), error: str(500, true),
    created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("workflow_steps", ["tenant_id", "run_id", "created_at"], { name: "ix_workflow_steps_run" });
  await tenantFk(sequelize, "workflow_steps", "run_id", "workflow_runs", "CASCADE");

  // Waits are DATABASE rows: the business deadline is the record of truth, not a queue timer.
  await qi.createTable("workflow_waits", {
    id: id(), tenant_id: tenantId(), run_id: uuid(false), node_id: str(80),
    kind: { type: DataTypes.ENUM("until", "event"), allowNull: false },
    resume_at: dt(), event_type: str(80, true), match_entity_id: uuid(), timeout_at: dt(),
    status: { type: DataTypes.ENUM("waiting", "resumed", "timed_out", "cancelled"), allowNull: false, defaultValue: "waiting" },
    resolved_by: str(40, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("workflow_waits", ["tenant_id", "status", "resume_at"], { name: "ix_workflow_waits_due" });
  await qi.addIndex("workflow_waits", ["tenant_id", "status", "event_type", "match_entity_id"], { name: "ix_workflow_waits_event" });
  await tenantFk(sequelize, "workflow_waits", "run_id", "workflow_runs", "CASCADE");
}
export async function down({ context: qi, sequelize }: Ctx) {
  await sequelize.query("DROP TRIGGER IF EXISTS workflow_versions_no_update");
  await sequelize.query("DROP TRIGGER IF EXISTS workflow_versions_no_delete");
  await sequelize.query("ALTER TABLE messages DROP FOREIGN KEY fk_messages_workflow_run_id");
  for (const t of ["workflow_waits", "workflow_steps", "workflow_runs", "workflow_versions", "workflows"]) await qi.dropTable(t);
}
