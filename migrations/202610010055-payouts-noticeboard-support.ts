import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, tenantKey, tenantFk, step } from "./_helpers";

/**
 * Three operations modules from the blueprint's gap list:
 *  - commission payout requests (an agent asks for their share of approved commissions; finance approves, rejects or pays);
 *  - a noticeboard with read/acknowledge receipts;
 *  - an internal support desk (tickets with comments, priority, assignment and SLA).
 */
export async function up({ context: qi, sequelize }: Ctx) {
  const money = () => ({ type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 });
  await step(() => qi.createTable("payout_requests", {
    id: id(), tenant_id: tenantId(), user_id: uuid(false),
    status: { type: DataTypes.ENUM("pending", "approved", "rejected", "paid", "cancelled"), allowNull: false, defaultValue: "pending" },
    net_amount: money(), vat_amount: money(), total_amount: money(), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "AED" },
    invoice_ref: str(80, true), note: str(500, true), requested_at: { type: DataTypes.DATE(3), allowNull: false },
    decided_by: str(64, true), decided_at: dt(), decision_reason: str(255, true), paid_by: str(64, true), paid_at: dt(), paid_reference: str(120, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "payout_requests"));
  await step(() => qi.addIndex("payout_requests", ["tenant_id", "status", "requested_at"], { name: "ix_payout_requests_status" }));
  await step(() => qi.addIndex("payout_requests", ["tenant_id", "user_id", "requested_at"], { name: "ix_payout_requests_user" }));
  await step(() => tenantFk(sequelize, "payout_requests", "user_id", "users"));

  await step(() => qi.createTable("payout_request_items", {
    id: id(), tenant_id: tenantId(), request_id: uuid(false), calculation_id: uuid(false), amount: money(), vat_amount: money(),
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, ...ts(),
  }));
  await step(() => tenantKey(qi, "payout_request_items"));
  await step(() => tenantFk(sequelize, "payout_request_items", "request_id", "payout_requests", "CASCADE"));
  await step(() => tenantFk(sequelize, "payout_request_items", "calculation_id", "commission_calculations"));
  // A commission can sit in at most one live (pending/approved/paid) request: rejected and cancelled requests free it again.
  await step(() => sequelize.query("ALTER TABLE payout_request_items ADD COLUMN live_calculation_id CHAR(36) GENERATED ALWAYS AS (IF(active = 1, calculation_id, NULL)) STORED"));
  await step(() => sequelize.query("ALTER TABLE payout_request_items ADD UNIQUE INDEX uq_payout_item_live (tenant_id, live_calculation_id)"));

  await step(() => qi.createTable("notice_posts", {
    id: id(), tenant_id: tenantId(), title: str(200), body: { type: DataTypes.TEXT, allowNull: false },
    audience: { type: DataTypes.ENUM("all", "branch"), allowNull: false, defaultValue: "all" }, branch_id: uuid(),
    pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, requires_ack: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    publish_at: { type: DataTypes.DATE(3), allowNull: false }, expires_at: dt(), archived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, created_by: str(64, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "notice_posts"));
  await step(() => qi.addIndex("notice_posts", ["tenant_id", "publish_at"], { name: "ix_notice_posts_publish" }));
  await step(() => qi.createTable("notice_reads", {
    id: id(), tenant_id: tenantId(), post_id: uuid(false), user_id: uuid(false), read_at: { type: DataTypes.DATE(3), allowNull: false }, acked_at: dt(), ...ts(),
  }));
  await step(() => tenantKey(qi, "notice_reads"));
  await step(() => qi.addIndex("notice_reads", ["tenant_id", "post_id", "user_id"], { unique: true, name: "uq_notice_reads" }));
  await step(() => tenantFk(sequelize, "notice_reads", "post_id", "notice_posts", "CASCADE"));
  await step(() => tenantFk(sequelize, "notice_reads", "user_id", "users", "CASCADE"));

  await step(() => qi.createTable("support_tickets", {
    id: id(), tenant_id: tenantId(), number: { type: DataTypes.INTEGER, allowNull: false }, subject: str(200), body: { type: DataTypes.TEXT, allowNull: false },
    category: { type: DataTypes.ENUM("bug", "access", "data", "question", "request", "other"), allowNull: false, defaultValue: "question" },
    priority: { type: DataTypes.ENUM("low", "normal", "high", "urgent"), allowNull: false, defaultValue: "normal" },
    status: { type: DataTypes.ENUM("open", "in_progress", "waiting", "resolved", "closed"), allowNull: false, defaultValue: "open" },
    requester_id: uuid(false), assignee_id: uuid(), due_at: dt(), first_response_at: dt(), resolved_at: dt(), page_url: str(300, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "support_tickets"));
  await step(() => qi.addIndex("support_tickets", ["tenant_id", "number"], { unique: true, name: "uq_support_ticket_number" }));
  await step(() => qi.addIndex("support_tickets", ["tenant_id", "status", "priority"], { name: "ix_support_tickets_queue" }));
  await step(() => qi.addIndex("support_tickets", ["tenant_id", "requester_id", "created_at"], { name: "ix_support_tickets_requester" }));
  await step(() => tenantFk(sequelize, "support_tickets", "requester_id", "users"));
  await step(() => tenantFk(sequelize, "support_tickets", "assignee_id", "users"));
  await step(() => qi.createTable("support_comments", {
    id: id(), tenant_id: tenantId(), ticket_id: uuid(false), author_id: uuid(false), body: { type: DataTypes.TEXT, allowNull: false },
    internal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, ...ts(),
  }));
  await step(() => tenantKey(qi, "support_comments"));
  await step(() => qi.addIndex("support_comments", ["tenant_id", "ticket_id", "created_at"], { name: "ix_support_comments_ticket" }));
  await step(() => tenantFk(sequelize, "support_comments", "ticket_id", "support_tickets", "CASCADE"));
  await step(() => tenantFk(sequelize, "support_comments", "author_id", "users"));
}

export async function down({ context: qi }: Ctx) {
  for (const t of ["support_comments", "support_tickets", "notice_reads", "notice_posts", "payout_request_items", "payout_requests"]) await qi.dropTable(t);
}
