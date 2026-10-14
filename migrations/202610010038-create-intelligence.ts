import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk } from "./_helpers";

async function appendOnly(sequelize: any, table: string, noDelete = true) {
  await sequelize.query(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
  if (noDelete) await sequelize.query(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`);
}

export async function up({ context: qi, sequelize }: Ctx) {
  // Scoring models are immutable once active: a change is a new version, so every score is reproducible from (model version, features).
  await qi.createTable("scoring_models", {
    id: id(), tenant_id: tenantId(), version: { type: DataTypes.INTEGER, allowNull: false }, kind: { type: DataTypes.ENUM("rules", "logistic"), allowNull: false },
    status: { type: DataTypes.ENUM("draft", "active", "retired"), allowNull: false, defaultValue: "draft" }, definition: json(false), metrics: json(), trained_on: { type: DataTypes.INTEGER, allowNull: true },
    created_by: str(64, true), activated_at: dt(), ...ts(),
  });
  await tenantKey(qi, "scoring_models");
  await qi.addIndex("scoring_models", ["tenant_id", "version"], { unique: true, name: "uq_scoring_model_version" });

  await qi.createTable("lead_scores", {
    id: id(), tenant_id: tenantId(), lead_id: uuid(false), model_id: uuid(false), model_version: { type: DataTypes.INTEGER, allowNull: false },
    score: { type: DataTypes.INTEGER, allowNull: false }, band: { type: DataTypes.ENUM("hot", "warm", "cold"), allowNull: false }, reasons: json(false), features: json(false),
    created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("lead_scores", ["tenant_id", "lead_id", "created_at"], { name: "ix_lead_scores_lead" });
  await tenantFk(sequelize, "lead_scores", "lead_id", "leads");
  await tenantFk(sequelize, "lead_scores", "model_id", "scoring_models");
  await appendOnly(sequelize, "lead_scores");

  await qi.createTable("bots", {
    id: id(), tenant_id: tenantId(), name: str(160), channel: { type: DataTypes.ENUM("whatsapp", "sms", "email"), allowNull: false },
    status: { type: DataTypes.ENUM("draft", "published", "disabled"), allowNull: false, defaultValue: "draft" }, current_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    draft_graph: json(), ...ts(),
  });
  await tenantKey(qi, "bots");
  await qi.addIndex("bots", ["tenant_id", "name"], { unique: true, name: "uq_bots_name" });

  await qi.createTable("bot_versions", {
    id: id(), tenant_id: tenantId(), bot_id: uuid(false), version: { type: DataTypes.INTEGER, allowNull: false }, graph: json(false), created_by: str(64, true), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("bot_versions", ["tenant_id", "bot_id", "version"], { unique: true, name: "uq_bot_versions" });
  await tenantFk(sequelize, "bot_versions", "bot_id", "bots");
  await appendOnly(sequelize, "bot_versions");

  await qi.createTable("bot_sessions", {
    id: id(), tenant_id: tenantId(), bot_id: uuid(false), bot_version: { type: DataTypes.INTEGER, allowNull: false }, contact_id: uuid(false), conversation_id: uuid(), lead_id: uuid(),
    status: { type: DataTypes.ENUM("active", "handed_off", "completed"), allowNull: false, defaultValue: "active" }, current_node: str(80, true), vars: json(), ai_tokens_used: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    step_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, handoff_reason: str(255, true), ...ts(),
  });
  await tenantKey(qi, "bot_sessions");
  await qi.addIndex("bot_sessions", ["tenant_id", "contact_id", "status"], { name: "ix_bot_sessions_contact" });
  await tenantFk(sequelize, "bot_sessions", "bot_id", "bots");
  await tenantFk(sequelize, "bot_sessions", "contact_id", "contacts");

  await qi.createTable("bot_session_events", {
    id: id(), tenant_id: tenantId(), session_id: uuid(false), direction: { type: DataTypes.ENUM("user", "bot", "system"), allowNull: false }, node_id: str(80, true), text: { type: DataTypes.TEXT, allowNull: true },
    detail: json(), created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("bot_session_events", ["tenant_id", "session_id", "created_at"], { name: "ix_bot_session_events" });
  await tenantFk(sequelize, "bot_session_events", "session_id", "bot_sessions");
  await appendOnly(sequelize, "bot_session_events");
}

export async function down({ context: qi, sequelize }: Ctx) {
  for (const t of ["lead_scores", "bot_versions", "bot_session_events"]) {
    await sequelize.query(`DROP TRIGGER IF EXISTS ${t}_no_update`);
    await sequelize.query(`DROP TRIGGER IF EXISTS ${t}_no_delete`);
  }
  for (const t of ["bot_session_events", "bot_sessions", "bot_versions", "bots", "lead_scores", "scoring_models"]) await qi.dropTable(t);
}
