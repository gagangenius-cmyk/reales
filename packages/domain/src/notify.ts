import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { logger } from "@reales/observability";
import { getSetting } from "./config";
import { getMailer } from "./mailer";
import { notifyInUow } from "./notifications";
import { Uow, withUow } from "./uow";

const appUrl = () => (process.env.APP_URL ?? process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
const link = (path?: string) => (path && appUrl() ? `\n\nOpen in the CRM: ${appUrl()}${path}` : "");

export type EmailSetting = "notifications.email.lead_assigned" | "notifications.email.followup_overdue" | "notifications.email.listing_expiring" | "notifications.email.listing_enquiry" | "notifications.email.deal_milestone" | "notifications.email.daily_digest";

export interface NotifyInput { userId: string; kind: string; title: string; body?: string; entityType?: string; entityId?: string; dedupeKey?: string; path?: string; email?: EmailSetting }

/**
 * In-app notification for a user, plus an e-mail when the company has that e-mail switched on in Settings. Safe to call from any business action: the
 * e-mail only joins a queue inside the same transaction, the scheduler sends it later, and a repeated dedupe key creates nothing the second time.
 */
export async function notifyUser(u: Uow, i: NotifyInput): Promise<boolean> {
  const created = await notifyInUow(u, { userId: i.userId, kind: i.kind, title: i.title, body: i.body, entityType: i.entityType, entityId: i.entityId, dedupeKey: i.dedupeKey });
  if (created && i.email && (await getSetting<boolean>(u.sq, u.tenantId, i.email))) {
    const user: any = await u.repo("User").findOne({ where: { id: i.userId, status: "active" }, transaction: u.tx });
    if (user?.get("email")) await queueEmail(u, { userId: i.userId, to: user.get("email"), kind: i.kind, subject: i.title, text: `${i.title}${i.body ? `\n\n${i.body}` : ""}${link(i.path)}`, dedupeKey: i.dedupeKey });
  }
  return created;
}

export async function queueEmail(u: Uow, m: { userId?: string; to: string; kind: string; subject: string; text: string; dedupeKey?: string; sendAfter?: Date }) {
  try {
    await u.repo("EmailQueue").create({ id: randomUUID(), userId: m.userId ?? null, toEmail: m.to, kind: m.kind, subject: m.subject.slice(0, 300), body: m.text, dedupeKey: m.dedupeKey ? m.dedupeKey.slice(0, 160) : null, status: "queued", attempts: 0, sendAfter: m.sendAfter ?? new Date() }, { transaction: u.tx });
  } catch (e: any) {
    if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") return false;
    throw e;
  }
  return true;
}

/** Sends due queued e-mails. A failure is retried with growing delays and given up on after 5 attempts; one bad address never blocks the rest. */
export async function deliverQueuedEmails(sq: Sequelize, ctx: RequestContext, limit = 50, now = new Date()) {
  const out = { sent: 0, failed: 0 };
  const due = await sq.query<{ id: string; to_email: string; subject: string; body: string; attempts: number }>(
    "SELECT id, to_email, subject, body, attempts FROM email_queue WHERE tenant_id=:t AND status='queued' AND send_after <= :now ORDER BY send_after LIMIT :limit",
    { replacements: { t: ctx.tenantId, now: mysqlDate(now), limit }, type: QueryTypes.SELECT });
  if (!due.length) return out;
  let mailer;
  try { mailer = getMailer(); } catch (e) { logger.warn({ err: e }, "e-mail not configured; notification e-mails stay queued"); return out; }
  for (const m of due) {
    try {
      await mailer.send({ to: m.to_email, subject: m.subject, text: m.body });
      await sq.query("UPDATE email_queue SET status='sent', sent_at=:now, attempts=attempts+1, last_error=NULL WHERE id=:id AND tenant_id=:t", { replacements: { id: m.id, t: ctx.tenantId, now: mysqlDate(now) } });
      out.sent++;
    } catch (e) {
      const attempts = m.attempts + 1, giveUp = attempts >= 5;
      await sq.query("UPDATE email_queue SET attempts=:a, status=:s, last_error=:err, send_after=:next WHERE id=:id AND tenant_id=:t", { replacements: { a: attempts, s: giveUp ? "failed" : "queued", err: (e instanceof Error ? e.message : "send failed").slice(0, 300), next: mysqlDate(new Date(now.getTime() + Math.min(2 ** attempts, 120) * 60_000)), id: m.id, t: ctx.tenantId } });
      out.failed++;
    }
  }
  return out;
}

/** One reminder per overdue follow-up, to the lead's agent (in-app always, e-mail if switched on). The dedupe key includes the due time, so rescheduling re-arms it. */
export async function followUpOverdueSweep(sq: Sequelize, ctx: RequestContext, now = new Date()) {
  return withUow(sq, ctx, async (u) => {
    const rows = (await u.repo("Lead").findAll({ where: { status: "open", assignedUserId: { [Op.ne]: null }, nextFollowUpAt: { [Op.ne]: null, [Op.lt]: now } }, limit: 500, transaction: u.tx })) as any[];
    let n = 0;
    for (const l of rows) {
      if (await notifyUser(u, { userId: l.get("assignedUserId"), kind: "lead.followup_overdue", title: "A lead follow-up is overdue", body: `${l.get("purpose")} lead, due ${new Date(l.get("nextFollowUpAt")).toISOString().slice(0, 16).replace("T", " ")} UTC`, entityType: "lead", entityId: l.get("id"), dedupeKey: `followup:${l.get("id")}:${+new Date(l.get("nextFollowUpAt"))}`, path: `/leads/${l.get("id")}`, email: "notifications.email.followup_overdue" })) n++;
    }
    return n;
  });
}

/** Morning summary for each agent (08:00-09:59 Dubai time, once a day): new leads, overdue follow-ups, listings expiring soon. Off unless the company enables it. */
export async function dailyDigestSweep(sq: Sequelize, ctx: RequestContext, now = new Date()) {
  const hourDubai = (now.getUTCHours() + 4) % 24;
  if (hourDubai < 8 || hourDubai > 9) return 0;
  return withUow(sq, ctx, async (u) => {
    if (!(await getSetting<boolean>(u.sq, u.tenantId, "notifications.email.daily_digest"))) return 0;
    const day = new Date(now.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
    const since = mysqlDate(new Date(now.getTime() - 24 * 3_600_000)), nowS = mysqlDate(now), soon = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10), today = now.toISOString().slice(0, 10);
    const agents = await u.sq.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE tenant_id=:t AND status='active' AND id IN (SELECT DISTINCT assigned_user_id FROM leads WHERE tenant_id=:t AND status='open' AND deleted_at IS NULL AND assigned_user_id IS NOT NULL)", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    let sent = 0;
    for (const a of agents) {
      const [c] = await u.sq.query<{ fresh: number; overdue: number; expiring: number }>(
        `SELECT (SELECT COUNT(*) FROM leads WHERE tenant_id=:t AND deleted_at IS NULL AND assigned_user_id=:u AND created_at >= :since) AS fresh,
                (SELECT COUNT(*) FROM leads WHERE tenant_id=:t AND deleted_at IS NULL AND assigned_user_id=:u AND status='open' AND next_follow_up_at < :now) AS overdue,
                (SELECT COUNT(*) FROM listings WHERE tenant_id=:t AND deleted_at IS NULL AND agent_user_id=:u AND status='published' AND expires_on BETWEEN :today AND :soon) AS expiring`,
        { replacements: { t: ctx.tenantId, u: a.id, since, now: nowS, today, soon }, transaction: u.tx, type: QueryTypes.SELECT });
      if (!c || (Number(c.fresh) + Number(c.overdue) + Number(c.expiring) === 0)) continue;
      if (await queueEmail(u, { userId: a.id, to: a.email, kind: "digest.daily", subject: `Your CRM summary for ${day}`, text: `Good morning.\n\nNew leads in the last 24 hours: ${c.fresh}\nFollow-ups overdue: ${c.overdue}\nListings expiring within 7 days: ${c.expiring}${link("/dashboard")}`, dedupeKey: `digest:${a.id}:${day}` })) sent++;
    }
    return sent;
  });
}
