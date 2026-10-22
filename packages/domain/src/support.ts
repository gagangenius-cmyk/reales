import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, WhereOptions } from "sequelize";
import type { RequestContext } from "@reales/database";
import { ForbiddenError, hasPermission } from "@reales/rbac";
import { nextCounter } from "./finance";
import { notifyInUow } from "./notifications";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const TICKET_CATEGORIES = ["bug", "access", "data", "question", "request", "other"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TICKET_STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"] as const;
/** First-response targets by priority (hours): the due time on a new ticket. */
const SLA_HOURS: Record<string, number> = { urgent: 2, high: 8, normal: 24, low: 72 };

const isDesk = (ctx: RequestContext) => hasPermission(ctx, "support.manage");

async function supportStaff(u: Uow, tenantId: string): Promise<string[]> {
  const rows = (await u.sq.query<{ user_id: string }>("SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id AND rp.tenant_id=ur.tenant_id JOIN permissions p ON p.id=rp.permission_id WHERE ur.tenant_id=:t AND p.`key`='support.manage'", { replacements: { t: tenantId }, transaction: u.tx, type: QueryTypes.SELECT })) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/** Anyone signed in can raise a ticket. */
export async function createSupportTicket(sq: Sequelize, ctx: RequestContext, i: { subject: string; body: string; category?: string; priority?: string; pageUrl?: string }) {
  if (!i.subject.trim() || !i.body.trim()) throw new ConflictError("A ticket needs a subject and a description");
  const category = i.category ?? "question", priority = i.priority ?? "normal";
  if (!TICKET_CATEGORIES.includes(category as never) || !TICKET_PRIORITIES.includes(priority as never)) throw new ConflictError("Unknown category or priority");
  return withUow(sq, ctx, async (u) => {
    const number = await nextCounter(u, ctx.tenantId, "support_ticket");
    const id = randomUUID();
    await u.repo("SupportTicket").create({ id, number, subject: i.subject.trim().slice(0, 200), body: i.body.trim().slice(0, 20000), category, priority, status: "open", requesterId: ctx.userId, dueAt: new Date(Date.now() + SLA_HOURS[priority]! * 3_600_000), pageUrl: i.pageUrl?.slice(0, 300) ?? null }, { transaction: u.tx });
    for (const s of await supportStaff(u, ctx.tenantId)) if (s !== ctx.userId) await notifyInUow(u, { userId: s, kind: "support.new", title: `New ticket #${number}: ${i.subject.trim().slice(0, 80)}`, body: `${priority} · ${category}`, entityType: "support_ticket", entityId: id, dedupeKey: `ticket-new:${id}:${s}` });
    await u.audit({ action: "support.ticket_created", entityType: "support_ticket", entityId: id, after: { number, priority, category } });
    return plain(await u.repo("SupportTicket").findById(id, { transaction: u.tx }));
  });
}

export async function listSupportTickets(sq: Sequelize, ctx: RequestContext, f: { status?: string; mine?: boolean; limit?: number; offset?: number } = {}) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [];
    if (!isDesk(ctx) || f.mine) and.push({ requesterId: ctx.userId });
    if (f.status === "active") and.push({ status: { [Op.in]: ["open", "in_progress", "waiting"] } });
    else if (f.status) and.push({ status: f.status });
    const rows = (await u.repo("SupportTicket").findAll({ where: { [Op.and]: and }, order: [["createdAt", "DESC"]], limit: Math.min(f.limit ?? 50, 200), offset: f.offset ?? 0, transaction: u.tx })) as any[];
    const users = (await u.repo("User").findAll({ where: { id: { [Op.in]: [...new Set(rows.flatMap((r) => [r.get("requesterId"), r.get("assigneeId")]).filter(Boolean))].concat(["-"]) } }, transaction: u.tx })) as any[];
    const email = new Map(users.map((x) => [x.get("id"), x.get("email") as string]));
    const now = Date.now();
    return rows.map((r) => ({ ...plain(r), requester: email.get(r.get("requesterId")) ?? "User", assignee: r.get("assigneeId") ? email.get(r.get("assigneeId")) ?? "Agent" : null,
      overdue: !r.get("firstResponseAt") && ["open", "in_progress"].includes(r.get("status")) && !!r.get("dueAt") && new Date(r.get("dueAt")).getTime() < now }));
  });
}

async function ticketFor(u: Uow, ctx: RequestContext, id: string) {
  const t: any = await u.repo("SupportTicket").findById(id, { transaction: u.tx });
  if (!t || (!isDesk(ctx) && t.get("requesterId") !== ctx.userId)) throw new NotFoundError("Ticket"); // never reveal other people's tickets
  return t;
}

export async function getSupportTicket(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const t = await ticketFor(u, ctx, id);
    const comments = (await u.repo("SupportComment").findAll({ where: { ticketId: id, ...(isDesk(ctx) ? {} : { internal: false }) }, order: [["createdAt", "ASC"]], transaction: u.tx })) as any[];
    const users = (await u.repo("User").findAll({ where: { id: { [Op.in]: [t.get("requesterId"), t.get("assigneeId"), ...comments.map((c) => c.get("authorId"))].filter(Boolean).concat(["-"]) } }, transaction: u.tx })) as any[];
    const email = new Map(users.map((x) => [x.get("id"), x.get("email") as string]));
    return { ...plain(t), requester: email.get(t.get("requesterId")) ?? "User", assignee: t.get("assigneeId") ? email.get(t.get("assigneeId")) ?? "Agent" : null, comments: comments.map((c) => ({ ...plain(c), author: email.get(c.get("authorId")) ?? "User" })) };
  });
}

/** Reply to a ticket. Desk staff may add internal notes the requester never sees; a requester reply re-opens a waiting or resolved ticket. */
export async function addSupportComment(sq: Sequelize, ctx: RequestContext, id: string, i: { body: string; internal?: boolean }) {
  if (!i.body.trim()) throw new ConflictError("Write a message");
  return withUow(sq, ctx, async (u) => {
    const t = await ticketFor(u, ctx, id);
    if (t.get("status") === "closed") throw new ConflictError("This ticket is closed");
    const desk = isDesk(ctx);
    if (i.internal && !desk) throw new ForbiddenError("Only the support desk can add internal notes");
    const cid = randomUUID();
    await u.repo("SupportComment").create({ id: cid, ticketId: id, authorId: ctx.userId, body: i.body.trim().slice(0, 20000), internal: !!i.internal }, { transaction: u.tx });
    const patch: Record<string, unknown> = {};
    if (desk && !t.get("firstResponseAt") && !i.internal && t.get("requesterId") !== ctx.userId) patch.firstResponseAt = new Date();
    if (!desk && ["waiting", "resolved"].includes(t.get("status"))) patch.status = "open";
    if (Object.keys(patch).length) await u.repo("SupportTicket").updateById(id, patch, { transaction: u.tx });
    if (!i.internal) {
      const to = desk ? [t.get("requesterId")] : [t.get("assigneeId")].filter(Boolean).length ? [t.get("assigneeId")] : await supportStaff(u, ctx.tenantId);
      for (const uid of to) if (uid && uid !== ctx.userId) await notifyInUow(u, { userId: uid, kind: "support.reply", title: `Ticket #${t.get("number")} has a new reply`, entityType: "support_ticket", entityId: id, dedupeKey: `ticket-reply:${cid}:${uid}` });
    }
    return { id: cid };
  });
}

/** Desk actions: change status, priority, category and assignee. Resolving stamps the time; the requester can reopen by replying. */
export async function updateSupportTicket(sq: Sequelize, ctx: RequestContext, id: string, i: { status?: string; priority?: string; assigneeId?: string | null }) {
  if (!isDesk(ctx)) throw new ForbiddenError("Missing permission: support.manage");
  return withUow(sq, ctx, async (u) => {
    const t = await ticketFor(u, ctx, id);
    const patch: Record<string, unknown> = {};
    if (i.status !== undefined) {
      if (!TICKET_STATUSES.includes(i.status as never)) throw new ConflictError("Unknown status");
      patch.status = i.status;
      patch.resolvedAt = ["resolved", "closed"].includes(i.status) ? new Date() : null;
    }
    if (i.priority !== undefined) { if (!TICKET_PRIORITIES.includes(i.priority as never)) throw new ConflictError("Unknown priority"); patch.priority = i.priority; }
    if (i.assigneeId !== undefined) {
      if (i.assigneeId && !(await u.repo("User").findOne({ where: { id: i.assigneeId, status: "active" }, transaction: u.tx }))) throw new NotFoundError("Assignee");
      patch.assigneeId = i.assigneeId;
      if (i.assigneeId && i.assigneeId !== t.get("assigneeId") && i.assigneeId !== ctx.userId) await notifyInUow(u, { userId: i.assigneeId, kind: "support.assigned", title: `Ticket #${t.get("number")} was assigned to you`, body: t.get("subject"), entityType: "support_ticket", entityId: id, dedupeKey: `ticket-assigned:${id}:${i.assigneeId}:${Date.now()}` });
      if (i.assigneeId && t.get("status") === "open" && patch.status === undefined) patch.status = "in_progress";
    }
    await u.repo("SupportTicket").updateById(id, patch, { transaction: u.tx });
    if (patch.status === "resolved" && t.get("requesterId") !== ctx.userId) await notifyInUow(u, { userId: t.get("requesterId"), kind: "support.resolved", title: `Ticket #${t.get("number")} was resolved`, entityType: "support_ticket", entityId: id, dedupeKey: `ticket-resolved:${id}:${Date.now()}` });
    await u.audit({ action: "support.ticket_updated", entityType: "support_ticket", entityId: id, before: { status: t.get("status"), priority: t.get("priority") }, after: patch });
    return plain(await u.repo("SupportTicket").findById(id, { transaction: u.tx }));
  });
}

/** Requester closes their own ticket once happy. */
export async function closeOwnSupportTicket(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const t = await ticketFor(u, ctx, id);
    if (t.get("requesterId") !== ctx.userId && !isDesk(ctx)) throw new ForbiddenError("Only the requester can close this ticket");
    await u.repo("SupportTicket").updateById(id, { status: "closed", resolvedAt: t.get("resolvedAt") ?? new Date() }, { transaction: u.tx });
    return plain(await u.repo("SupportTicket").findById(id, { transaction: u.tx }));
  });
}
