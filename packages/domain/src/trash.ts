import { QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { authorize, can, ForbiddenError, hasPermission } from "@reales/rbac";
import { ConflictError, NotFoundError, withUow } from "./uow";

/**
 * Soft delete, restore and purge for the business records that people create and may remove by mistake (see migration 058 for the tables and for what is
 * deliberately excluded: finance, deals, leases, compliance, audit, identity). Deleting stamps deleted_at/deleted_by; every normal read skips such rows;
 * Trash lists them; restore clears the stamp; purge erases for good and is limited to tenant administrators.
 */
export interface TrashEntity {
  table: string; label: string; plural: string;
  /** SQL expression for a human label of one row (alias t). */
  title: string;
  /** Permission needed to delete or restore. */
  perm: string;
  owner?: string; branch?: string; project?: string;
  /** Refuse to delete while this returns a reason (runs inside the transaction). */
  guard?: (c: Q, id: string) => Promise<string | null>;
  /** Refuse to restore while a parent is itself deleted. */
  parent?: { table: string; column: string; label: string };
}
type Q = (sql: string, rep?: Record<string, unknown>) => Promise<any[]>;

const name = (a = "name") => `t.${a}`;
export const TRASH_ENTITIES: Record<string, TrashEntity> = {
  contact: { table: "contacts", label: "Contact", plural: "Contacts", title: "COALESCE(NULLIF(TRIM(CONCAT_WS(' ', t.first_name, t.last_name)), ''), t.company_name, t.email, t.phone_e164, 'Contact')", perm: "contact.update", owner: "owner_user_id", branch: "branch_id",
    guard: async (q, id) => ((await q("SELECT COUNT(*) n FROM leads WHERE tenant_id=:t AND contact_id=:id AND status='open' AND deleted_at IS NULL", { id }))[0].n > 0 ? "This contact still has open leads. Close or delete those first." : null) },
  organization: { table: "organizations", label: "Organisation", plural: "Organisations", title: name(), perm: "org.manage" },
  lead: { table: "leads", label: "Lead", plural: "Leads", title: "CONCAT(t.purpose, ' lead ', LEFT(t.id, 8))", perm: "lead.assign", owner: "assigned_user_id", branch: "branch_id", project: "project_id",
    parent: { table: "contacts", column: "contact_id", label: "contact" } },
  task: { table: "tasks", label: "Task", plural: "Tasks", title: "t.title", perm: "lead.update", owner: "assignee_id" },
  developer: { table: "developers", label: "Developer", plural: "Developers", title: name(), perm: "project.manage",
    guard: async (q, id) => ((await q("SELECT COUNT(*) n FROM real_estate_projects WHERE tenant_id=:t AND developer_id=:id AND deleted_at IS NULL", { id }))[0].n > 0 ? "This developer still has projects." : null) },
  project: { table: "real_estate_projects", label: "Project", plural: "Projects", title: name(), perm: "project.manage",
    guard: async (q, id) => ((await q("SELECT COUNT(*) n FROM buildings WHERE tenant_id=:t AND re_project_id=:id AND deleted_at IS NULL", { id }))[0].n > 0 ? "This project still has buildings." : null) },
  building: { table: "buildings", label: "Building", plural: "Buildings", title: name(), perm: "inventory.manage",
    guard: async (q, id) => ((await q("SELECT COUNT(*) n FROM units WHERE tenant_id=:t AND building_id=:id AND deleted_at IS NULL", { id }))[0].n > 0 ? "This building still has units." : null),
    parent: { table: "real_estate_projects", column: "re_project_id", label: "project" } },
  unit: { table: "units", label: "Unit", plural: "Units", title: "CONCAT('Unit ', t.unit_number)", perm: "inventory.manage",
    guard: async (q, id) => {
      if ((await q("SELECT COUNT(*) n FROM listings WHERE tenant_id=:t AND unit_id=:id AND deleted_at IS NULL", { id }))[0].n > 0) return "This unit still has listings. Delete those first.";
      if ((await q("SELECT COUNT(*) n FROM leases WHERE tenant_id=:t AND unit_id=:id AND status NOT IN ('terminated','expired','cancelled','draft')", { id }))[0].n > 0) return "This unit has a live lease.";
      return null;
    },
    parent: { table: "buildings", column: "building_id", label: "building" } },
  listing: { table: "listings", label: "Listing", plural: "Listings", title: "COALESCE(t.title, t.reference, 'Listing')", perm: "listing.manage", owner: "agent_user_id", branch: "branch_id", project: "project_id",
    guard: async (q, id) => ((await q("SELECT status FROM listings WHERE tenant_id=:t AND id=:id", { id }))[0]?.status === "published" ? "Unpublish this listing before deleting it." : null),
    parent: { table: "units", column: "unit_id", label: "unit" } },
  viewing: { table: "viewings", label: "Viewing", plural: "Viewings", title: "CONCAT('Viewing ', LEFT(t.id, 8))", perm: "viewing.manage", owner: "agent_user_id", branch: "branch_id" },
  template: { table: "templates", label: "Template", plural: "Templates", title: name(), perm: "template.manage" },
  segment: { table: "segments", label: "Segment", plural: "Segments", title: name(), perm: "segment.manage" },
  campaign: { table: "campaigns", label: "Campaign", plural: "Campaigns", title: name(), perm: "campaign.manage",
    guard: async (q, id) => (["running", "sending", "scheduled"].includes((await q("SELECT status FROM campaigns WHERE tenant_id=:t AND id=:id", { id }))[0]?.status) ? "Cancel or finish this campaign first." : null) },
  workflow: { table: "workflows", label: "Workflow", plural: "Workflows", title: name(), perm: "workflow.manage" },
  bot: { table: "bots", label: "Bot", plural: "Bots", title: name(), perm: "bot.manage" },
  vendor: { table: "vendors", label: "Vendor", plural: "Vendors", title: name(), perm: "vendor.manage" },
  portfolio: { table: "portfolios", label: "Portfolio", plural: "Portfolios", title: name(), perm: "portfolio.manage" },
  saved_search: { table: "saved_searches", label: "Saved search", plural: "Saved searches", title: name(), perm: "match.manage", owner: "owner_user_id" },
  referral_partner: { table: "referral_partners", label: "Referral partner", plural: "Referral partners", title: name(), perm: "referral.manage" },
  notice: { table: "notice_posts", label: "Notice", plural: "Notices", title: "t.title", perm: "notice.manage", branch: "branch_id" },
  support_ticket: { table: "support_tickets", label: "Support ticket", plural: "Support tickets", title: "CONCAT('#', t.number, ' ', t.subject)", perm: "support.manage" },
  lead_pool: { table: "lead_pools", label: "Lead pool", plural: "Lead pools", title: name(), perm: "pool.manage",
    guard: async (q, id) => ((await q("SELECT COUNT(*) n FROM leads WHERE tenant_id=:t AND pool_id=:id AND status='open' AND assigned_user_id IS NULL AND deleted_at IS NULL", { id }))[0].n > 0 ? "Leads are still waiting in this pool." : null) },
  document: { table: "documents", label: "Document", plural: "Documents", title: "COALESCE(t.title, 'Document')", perm: "document.manage" },
};

export const TRASH_KEYS = Object.keys(TRASH_ENTITIES);
const entity = (key: string) => TRASH_ENTITIES[key] ?? (() => { throw new NotFoundError("Record type"); })();

async function load(q: Q, e: TrashEntity, id: string, deleted: boolean) {
  const cols = ["id", e.owner && `${e.owner} AS owner`, e.branch && `${e.branch} AS branch`, e.project && `${e.project} AS project`, "deleted_by"].filter(Boolean).join(", ");
  const [row] = await q(`SELECT ${cols}, (SELECT 1) AS ok FROM \`${e.table}\` WHERE tenant_id=:t AND id=:id AND deleted_at IS ${deleted ? "NOT " : ""}NULL`, { id });
  return row as { id: string; owner?: string; branch?: string; project?: string; deleted_by?: string | null } | undefined;
}
const ref = (r: { owner?: string; branch?: string; project?: string }) => ({ ownerUserId: r.owner ?? null, branchId: r.branch ?? null, projectId: r.project ?? null });

/** Moves one record to Trash. The reason is kept in the audit trail. */
export async function softDelete(sq: Sequelize, ctx: RequestContext, key: string, id: string, reason?: string) {
  const e = entity(key);
  return withUow(sq, ctx, async (u) => {
    const q: Q = (sql, rep = {}) => u.sq.query(sql, { replacements: { t: ctx.tenantId, ...rep }, transaction: u.tx, type: QueryTypes.SELECT }) as Promise<any[]>;
    const row = await load(q, e, id, false);
    if (!row) throw new NotFoundError(e.label);
    authorize(ctx, e.perm, ref(row));
    const why = await e.guard?.(q, id);
    if (why) throw new ConflictError(why);
    const [title] = await q(`SELECT ${e.title} AS title FROM \`${e.table}\` t WHERE t.tenant_id=:t AND t.id=:id`, { id });
    await u.sq.query(`UPDATE \`${e.table}\` SET deleted_at=:now, deleted_by=:by WHERE tenant_id=:t AND id=:id AND deleted_at IS NULL`, { replacements: { now: mysqlDate(new Date()), by: ctx.userId, t: ctx.tenantId, id }, transaction: u.tx });
    await u.audit({ action: "record.deleted", entityType: e.table, entityId: id, before: { title: title?.title ?? null }, after: { deleted: true, reason: reason ?? null } });
    return { id, entity: key, title: title?.title ?? e.label };
  });
}

/** Everything the caller may restore: all of it with a tenant-wide grant, otherwise only what they deleted themselves. */
export async function listTrash(sq: Sequelize, ctx: RequestContext, o: { entity?: string; q?: string; limit?: number; offset?: number } = {}) {
  const keys = (o.entity ? [o.entity] : TRASH_KEYS).filter((k) => TRASH_ENTITIES[k] && hasPermission(ctx, TRASH_ENTITIES[k]!.perm));
  if (o.entity && keys.length === 0) throw new ForbiddenError("Missing permission");
  return withUow(sq, ctx, async (u) => {
    const parts: string[] = [];
    const rep: Record<string, unknown> = { t: ctx.tenantId, me: ctx.userId, like: o.q ? `%${o.q.trim().replace(/[%_\\]/g, "\\$&")}%` : null };
    for (const k of keys) {
      const e = TRASH_ENTITIES[k]!, all = can(ctx, e.perm);
      parts.push(`SELECT '${k}' AS entity, t.id, ${e.title} AS title, t.deleted_at, t.deleted_by FROM \`${e.table}\` t WHERE t.tenant_id=:t AND t.deleted_at IS NOT NULL${all ? "" : " AND t.deleted_by=:me"}${o.q ? ` AND (${e.title}) LIKE :like` : ""}`);
    }
    if (!parts.length) return { rows: [], total: 0 };
    const union = parts.join(" UNION ALL ");
    const [rows, [count]] = await Promise.all([
      u.sq.query(`SELECT x.*, us.email AS deleted_by_email FROM (${union}) x LEFT JOIN users us ON us.id=x.deleted_by AND us.tenant_id=:t ORDER BY x.deleted_at DESC LIMIT :limit OFFSET :offset`, { replacements: { ...rep, limit: Math.min(o.limit ?? 50, 200), offset: o.offset ?? 0 }, transaction: u.tx, type: QueryTypes.SELECT }),
      u.sq.query(`SELECT COUNT(*) n FROM (${union}) x`, { replacements: rep, transaction: u.tx, type: QueryTypes.SELECT }),
    ]) as [any[], any[]];
    return { rows: rows.map((r) => ({ entity: r.entity as string, label: TRASH_ENTITIES[r.entity]!.label, id: r.id as string, title: r.title as string, deletedAt: new Date(r.deleted_at).toISOString(), deletedBy: (r.deleted_by_email as string | null) ?? null })), total: Number(count.n) };
  });
}

export async function restoreRecord(sq: Sequelize, ctx: RequestContext, key: string, id: string) {
  const e = entity(key);
  return withUow(sq, ctx, async (u) => {
    const q: Q = (sql, rep = {}) => u.sq.query(sql, { replacements: { t: ctx.tenantId, ...rep }, transaction: u.tx, type: QueryTypes.SELECT }) as Promise<any[]>;
    const row = await load(q, e, id, true);
    if (!row) throw new NotFoundError(`${e.label} in Trash`);
    authorize(ctx, e.perm, ref(row));
    if (!can(ctx, e.perm) && row.deleted_by !== ctx.userId) throw new ForbiddenError("Only the person who deleted it, or a manager, can restore this");
    if (e.parent) {
      const [p] = await q(`SELECT 1 AS x FROM \`${e.table}\` c JOIN \`${e.parent.table}\` p ON p.id=c.${e.parent.column} AND p.tenant_id=c.tenant_id WHERE c.tenant_id=:t AND c.id=:id AND p.deleted_at IS NOT NULL`, { id });
      if (p) throw new ConflictError(`Restore the ${e.parent.label} first.`);
    }
    try {
      await u.sq.query(`UPDATE \`${e.table}\` SET deleted_at=NULL, deleted_by=NULL WHERE tenant_id=:t AND id=:id`, { replacements: { t: ctx.tenantId, id }, transaction: u.tx });
    } catch (err: any) {
      if (err?.original?.errno === 1062 || err?.parent?.errno === 1062) throw new ConflictError("A live record with the same name or number now exists. Rename that one first.");
      throw err;
    }
    await u.audit({ action: "record.restored", entityType: e.table, entityId: id, after: { restored: true } });
    return { id, entity: key };
  });
}

/** Permanently erases a record that is already in Trash. Tenant administrators only; refused when other records still depend on it. */
export async function purgeRecord(sq: Sequelize, ctx: RequestContext, key: string, id: string) {
  const e = entity(key);
  authorize(ctx, "tenant.manage");
  return withUow(sq, ctx, async (u) => {
    const q: Q = (sql, rep = {}) => u.sq.query(sql, { replacements: { t: ctx.tenantId, ...rep }, transaction: u.tx, type: QueryTypes.SELECT }) as Promise<any[]>;
    if (!(await load(q, e, id, true))) throw new NotFoundError(`${e.label} in Trash`);
    try {
      await u.sq.query(`DELETE FROM \`${e.table}\` WHERE tenant_id=:t AND id=:id AND deleted_at IS NOT NULL`, { replacements: { t: ctx.tenantId, id }, transaction: u.tx });
    } catch (err: any) {
      if ([1451, 1217].includes(err?.original?.errno) || [1451, 1217].includes(err?.parent?.errno)) throw new ConflictError("Other records still refer to this one, so it can only stay in Trash.");
      throw err;
    }
    await u.audit({ action: "record.purged", entityType: e.table, entityId: id, after: { purged: true } });
    return { id, entity: key };
  });
}
