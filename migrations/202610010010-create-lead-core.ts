import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("lead_sources", {
    id: id(), tenant_id: tenantId(), code: str(60), name: str(120),
    kind: { type: DataTypes.ENUM("portal", "campaign", "walk_in", "referral", "api", "call", "form", "other"), allowNull: false }, ...ts(),
  });
  await tenantKey(qi, "lead_sources");
  await qi.addIndex("lead_sources", ["tenant_id", "code"], { unique: true, name: "uq_lead_sources_code" });

  // Pipelines and stages are part of lead-core here (the blueprint splits them into migration 012).
  await qi.createTable("pipelines", {
    id: id(), tenant_id: tenantId(), name: str(120), is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    project_id: uuid(), ...ts(),
  });
  await tenantKey(qi, "pipelines");
  await qi.addIndex("pipelines", ["tenant_id", "project_id"], { name: "ix_pipelines_tenant_project" });
  await tenantFk(sequelize, "pipelines", "project_id", "projects");

  await qi.createTable("pipeline_stages", {
    id: id(), tenant_id: tenantId(), pipeline_id: uuid(false), key: str(40), name: str(80),
    position: { type: DataTypes.INTEGER, allowNull: false },
    kind: { type: DataTypes.ENUM("open", "won", "lost"), allowNull: false, defaultValue: "open" },
    sla_minutes: { type: DataTypes.INTEGER, allowNull: true }, ...ts(),
  });
  await tenantKey(qi, "pipeline_stages");
  await qi.addIndex("pipeline_stages", ["tenant_id", "pipeline_id", "key"], { unique: true, name: "uq_pipeline_stage_key" });
  await tenantFk(sequelize, "pipeline_stages", "pipeline_id", "pipelines", "CASCADE");

  await qi.createTable("routing_rules", {
    id: id(), tenant_id: tenantId(), name: str(120), priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    conditions: json(false), target: json(false),
    strategy: { type: DataTypes.ENUM("round_robin", "least_loaded"), allowNull: false, defaultValue: "round_robin" },
    max_open_leads: { type: DataTypes.INTEGER, allowNull: true }, ...ts(),
  });
  await tenantKey(qi, "routing_rules");
  await qi.addIndex("routing_rules", ["tenant_id", "active", "priority"], { name: "ix_routing_rules_active" });

  await qi.createTable("leads", {
    id: id(), tenant_id: tenantId(), contact_id: uuid(false), project_id: uuid(), source_id: uuid(),
    pipeline_id: uuid(false), stage_id: uuid(false),
    status: { type: DataTypes.ENUM("open", "won", "lost"), allowNull: false, defaultValue: "open" },
    purpose: { type: DataTypes.ENUM("buy", "rent", "invest", "off_plan"), allowNull: false },
    budget_min: { type: DataTypes.DECIMAL(18, 2), allowNull: true }, budget_max: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    preferred_areas: json(), bedrooms: { type: DataTypes.INTEGER, allowNull: true }, language: { type: DataTypes.STRING(10), allowNull: true },
    assigned_user_id: uuid(), branch_id: uuid(), score: { type: DataTypes.DECIMAL(6, 3), allowNull: true },
    lost_reason: str(255, true), first_response_at: dt(), ...ts(),
  });
  await tenantKey(qi, "leads");
  await qi.addIndex("leads", ["tenant_id", "assigned_user_id", "status"], { name: "ix_leads_tenant_assignee_status" });
  await qi.addIndex("leads", ["tenant_id", "project_id", "status"], { name: "ix_leads_tenant_project_status" });
  await qi.addIndex("leads", ["tenant_id", "branch_id", "status"], { name: "ix_leads_tenant_branch_status" });
  await qi.addIndex("leads", ["tenant_id", "stage_id"], { name: "ix_leads_tenant_stage" });
  await qi.addIndex("leads", ["tenant_id", "contact_id"], { name: "ix_leads_tenant_contact" });
  await qi.addIndex("leads", ["tenant_id", "created_at"], { name: "ix_leads_tenant_created" });
  await tenantFk(sequelize, "leads", "contact_id", "contacts");
  await tenantFk(sequelize, "leads", "project_id", "projects");
  await tenantFk(sequelize, "leads", "source_id", "lead_sources");
  await tenantFk(sequelize, "leads", "pipeline_id", "pipelines");
  await tenantFk(sequelize, "leads", "stage_id", "pipeline_stages");
  await tenantFk(sequelize, "leads", "assigned_user_id", "users");
  await tenantFk(sequelize, "leads", "branch_id", "branches");

  // Explicit history: leads.stage_id is the projection, lead_stage_events is the truth.
  await qi.createTable("lead_stage_events", {
    id: id(), tenant_id: tenantId(), lead_id: uuid(false), from_stage_id: uuid(), to_stage_id: uuid(false),
    actor_id: str(64, true), reason: str(255, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("lead_stage_events", ["tenant_id", "lead_id", "created_at"], { name: "ix_lead_stage_events_lead" });
  await tenantFk(sequelize, "lead_stage_events", "lead_id", "leads");

  await qi.createTable("lead_assignments", {
    id: id(), tenant_id: tenantId(), lead_id: uuid(false), assigned_user_id: uuid(), previous_user_id: uuid(),
    rule_id: uuid(), method: { type: DataTypes.ENUM("rule", "manual", "fallback"), allowNull: false },
    reason: str(255, true), actor_id: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("lead_assignments", ["tenant_id", "lead_id", "created_at"], { name: "ix_lead_assignments_lead" });
  await qi.addIndex("lead_assignments", ["tenant_id", "assigned_user_id", "created_at"], { name: "ix_lead_assignments_user" });
  await tenantFk(sequelize, "lead_assignments", "lead_id", "leads");
}
export async function down({ context: qi }: Ctx) {
  for (const t of ["lead_assignments", "lead_stage_events", "leads", "routing_rules", "pipeline_stages", "pipelines", "lead_sources"]) await qi.dropTable(t);
}
