import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

/**
 * Enterprise organisation and transaction controls:
 *  - teams get a leader, an optional parent team and member roles (team leader vs member);
 *  - sales targets per person, team, branch or the whole workspace, by month / quarter / year;
 *  - deal checklists: reusable templates per deal type whose items are copied onto each deal, can gate a stage, and may be waived with a reason;
 *  - commission slabs: the rate (and the agent's share) step up as an agent's closed value in the year grows.
 */
/** MySQL DDL is not transactional, so a half-applied run must be safe to repeat: tolerate "already exists" for each step. */
const ALREADY = new Set([1050, 1060, 1061, 1826, 1022, 1068]);
async function step(fn: () => Promise<unknown>) {
  try { await fn(); } catch (e) {
    const errno = (e as { parent?: { errno?: number }; original?: { errno?: number } }).parent?.errno ?? (e as { original?: { errno?: number } }).original?.errno;
    if (!errno || !ALREADY.has(errno)) throw e;
  }
}

export async function up({ context: qi, sequelize }: Ctx) {
  await step(() => qi.addColumn("teams", "leader_user_id", uuid()));
  await step(() => qi.addColumn("teams", "parent_team_id", uuid()));
  await step(() => qi.addColumn("teams", "description", str(255, true)));
  await step(() => qi.addColumn("teams", "status", { type: DataTypes.ENUM("active", "archived"), allowNull: false, defaultValue: "active" }));
  await step(() => tenantKey(qi, "teams"));
  await step(() => tenantFk(sequelize, "teams", "leader_user_id", "users", "SET NULL"));
  await step(() => tenantFk(sequelize, "teams", "parent_team_id", "teams", "SET NULL"));
  await step(() => qi.addColumn("team_members", "role", { type: DataTypes.ENUM("leader", "member"), allowNull: false, defaultValue: "member" }));
  await step(() => qi.addColumn("team_members", "joined_on", { type: DataTypes.DATEONLY, allowNull: true }));

  await step(() => qi.createTable("sales_targets", {
    id: id(), tenant_id: tenantId(),
    scope_type: { type: DataTypes.ENUM("user", "team", "branch", "tenant"), allowNull: false },
    scope_id: uuid(), // null only for scope_type = tenant
    period_type: { type: DataTypes.ENUM("month", "quarter", "year"), allowNull: false },
    period_start: { type: DataTypes.DATEONLY, allowNull: false },
    metric: { type: DataTypes.ENUM("closed_value", "closed_deals", "new_leads", "viewings_done"), allowNull: false },
    target_value: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
    note: str(255, true), created_by: str(64, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "sales_targets"));
  await step(() => qi.addIndex("sales_targets", ["tenant_id", "scope_type", "scope_id", "period_type", "period_start", "metric"], { unique: true, name: "uq_sales_targets_scope" }));
  await step(() => qi.addIndex("sales_targets", ["tenant_id", "period_start"], { name: "ix_sales_targets_period" }));

  await step(() => qi.createTable("deal_checklist_templates", {
    id: id(), tenant_id: tenantId(), name: str(160), deal_type: { type: DataTypes.ENUM("sale", "lease"), allowNull: false },
    project_kind: { type: DataTypes.ENUM("any", "ready", "off_plan"), allowNull: false, defaultValue: "any" },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, ...ts(),
  }));
  await step(() => tenantKey(qi, "deal_checklist_templates"));
  await step(() => qi.createTable("deal_checklist_template_items", {
    id: id(), tenant_id: tenantId(), template_id: uuid(false), position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    title: str(200), guidance: str(500, true), required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    gate_stage: { type: DataTypes.ENUM("none", "contract", "signed", "payment", "registration", "closed"), allowNull: false, defaultValue: "none" },
    due_offset_days: { type: DataTypes.INTEGER, allowNull: true }, ...ts(),
  }));
  await step(() => tenantKey(qi, "deal_checklist_template_items"));
  await step(() => qi.addIndex("deal_checklist_template_items", ["tenant_id", "template_id", "position"], { name: "ix_checklist_template_items" }));
  await step(() => tenantFk(sequelize, "deal_checklist_template_items", "template_id", "deal_checklist_templates", "CASCADE"));

  await step(() => qi.createTable("deal_checklist_items", {
    id: id(), tenant_id: tenantId(), deal_id: uuid(false), template_item_id: uuid(), position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    title: str(200), guidance: str(500, true), required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    gate_stage: { type: DataTypes.ENUM("none", "contract", "signed", "payment", "registration", "closed"), allowNull: false, defaultValue: "none" },
    status: { type: DataTypes.ENUM("pending", "done", "waived"), allowNull: false, defaultValue: "pending" },
    due_at: dt(), assignee_user_id: uuid(), completed_by: str(64, true), completed_at: dt(), waived_reason: str(255, true), document_id: uuid(), note: str(500, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "deal_checklist_items"));
  await step(() => qi.addIndex("deal_checklist_items", ["tenant_id", "deal_id", "position"], { name: "ix_deal_checklist_items_deal" }));
  await step(() => qi.addIndex("deal_checklist_items", ["tenant_id", "assignee_user_id", "status"], { name: "ix_deal_checklist_items_assignee" }));
  await step(() => tenantFk(sequelize, "deal_checklist_items", "deal_id", "deals", "CASCADE"));
  await step(() => tenantFk(sequelize, "deal_checklist_items", "assignee_user_id", "users", "SET NULL"));

  await step(() => qi.addColumn("commission_plans", "slabs", json()));
  await step(() => qi.addColumn("commission_calculations", "slab_applied", json()));
}


export async function down({ context: qi }: Ctx) {
  await qi.removeColumn("commission_calculations", "slab_applied");
  await qi.removeColumn("commission_plans", "slabs");
  for (const t of ["deal_checklist_items", "deal_checklist_template_items", "deal_checklist_templates", "sales_targets"]) await qi.dropTable(t);
  await qi.removeColumn("team_members", "joined_on");
  await qi.removeColumn("team_members", "role");
  for (const c of ["status", "description", "parent_team_id", "leader_user_id"]) await qi.removeColumn("teams", c);
}
