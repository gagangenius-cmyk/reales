import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { ForbiddenError, hasPermission, widestScope } from "@reales/rbac";
import { LEAD_SCOPE } from "./leads";
import { plain, scopeWhere } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const CALL_OUTCOMES = ["answered", "no_answer", "busy", "voicemail", "wrong_number", "callback_requested", "not_interested"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export interface CallInput { leadId?: string; contactId?: string; direction?: "outbound" | "inbound"; outcome: CallOutcome; startedAt?: string; durationSec?: number; notes?: string; followUpAt?: string; recordingUrl?: string }

const mustHave = (ctx: RequestContext, p: string) => { if (!hasPermission(ctx, p)) throw new ForbiddenError(`Missing permission: ${p}`); };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Record a call against a lead or contact. One write keeps everything honest: the call log, a timeline entry on the lead, "last contacted" on the lead and
 * contact, the first-response time (if this is the first touch), and the follow-up. A requested callback with no date defaults to tomorrow 10:00 Dubai.
 */
export async function logCall(sq: Sequelize, ctx: RequestContext, i: CallInput) {
  mustHave(ctx, "call.log");
  if (!CALL_OUTCOMES.includes(i.outcome)) throw new ConflictError("Unknown call outcome");
  const duration = Math.round(i.durationSec ?? 0);
  if (!(duration >= 0 && duration <= 6 * 3600)) throw new ConflictError("Call duration must be between 0 seconds and 6 hours");
  if (i.outcome === "answered" && duration === 0) throw new ConflictError("An answered call needs a duration");
  const started = i.startedAt ? new Date(i.startedAt) : new Date();
  if (Number.isNaN(started.getTime())) throw new ConflictError("Invalid call time");
  if (started.getTime() > Date.now() + 5 * 60_000) throw new ConflictError("A call cannot start in the future");
  return withUow(sq, ctx, async (u) => {
    let lead: any = null;
    if (i.leadId) {
      const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
      lead = await u.repo("Lead").findOne({ where: { [Op.and]: [{ id: i.leadId }, scope] }, transaction: u.tx });
      if (!lead) throw new NotFoundError("Lead");
    }
    const contactId = i.contactId ?? lead?.get("contactId");
    if (!contactId) throw new ConflictError("A call needs a lead or a contact");
    const contact: any = await u.repo("Contact").findById(contactId, { transaction: u.tx });
    if (!contact) throw new NotFoundError("Contact");
    if (lead && lead.get("contactId") !== contactId) throw new ConflictError("That contact does not belong to this lead");

    const id = randomUUID();
    let followUp: Date | null = i.followUpAt ? new Date(i.followUpAt) : null;
    if (!followUp && i.outcome === "callback_requested") { const d = new Date(Date.now() + 4 * 3_600_000 + 86_400_000); followUp = new Date(`${d.toISOString().slice(0, 10)}T10:00:00+04:00`); }
    if (followUp && Number.isNaN(followUp.getTime())) throw new ConflictError("Invalid follow-up time");
    await u.repo("CallLog").create({ id, userId: ctx.userId, leadId: lead?.get("id") ?? null, contactId, direction: i.direction ?? "outbound", outcome: i.outcome, startedAt: started, durationSec: duration, notes: i.notes?.trim() || null, followUpAt: followUp, recordingUrl: i.recordingUrl ?? null }, { transaction: u.tx });

    const now = new Date();
    if (lead) {
      const patch: Record<string, unknown> = { lastContactedAt: now };
      if (!lead.get("firstResponseAt")) patch.firstResponseAt = now;
      if (followUp) patch.nextFollowUpAt = followUp;
      await u.repo("Lead").updateById(lead.get("id"), patch, { transaction: u.tx });
      await u.repo("Activity").create({ id: randomUUID(), entityType: "lead", entityId: lead.get("id"), kind: "call", summary: `${(i.direction ?? "outbound") === "inbound" ? "Inbound" : "Outbound"} call, ${i.outcome.replace(/_/g, " ")}${duration ? ` (${mmss(duration)})` : ""}${i.notes?.trim() ? `: ${i.notes.trim()}` : ""}`.slice(0, 4000), actorId: ctx.userId, occurredAt: mysqlDate(started), createdAt: mysqlDate(now) }, { transaction: u.tx });
    }
    await u.repo("Contact").updateById(contactId, { lastContactedAt: now }, { transaction: u.tx });
    await u.emit({ type: "call.logged", aggregateType: lead ? "lead" : "contact", aggregateId: lead?.get("id") ?? contactId, projectId: lead?.get("projectId") ?? null, payload: { callId: id, outcome: i.outcome, durationSec: duration } });
    return plain(await u.repo("CallLog").findById(id, { transaction: u.tx }));
  });
}

/** Whose calls the caller may see: tenant scope = everyone, branch/unit scope = people in it, otherwise only their own. */
async function visibleUserIds(u: Uow, ctx: RequestContext): Promise<string[] | null> {
  const scope = widestScope(ctx, "call.read");
  if (scope === "tenant") return null;
  if (scope === "branch" || scope === "business_unit") {
    const where: WhereOptions = scope === "branch" ? { branchId: { [Op.in]: ctx.membership.branchIds.length ? ctx.membership.branchIds : ["-"] } } : { businessUnitId: { [Op.in]: ctx.membership.businessUnitIds.length ? ctx.membership.businessUnitIds : ["-"] } };
    const rows = (await u.repo("User").findAll({ where, transaction: u.tx })) as any[];
    return [...new Set([ctx.userId, ...rows.map((r) => r.get("id") as string)])];
  }
  return [ctx.userId];
}

export async function listCalls(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; userId?: string; leadId?: string; outcome?: string; from?: string; to?: string }) {
  mustHave(ctx, "call.read");
  return withUow(sq, ctx, async (u) => {
    const ids = await visibleUserIds(u, ctx);
    const and: WhereOptions[] = [];
    if (ids) and.push({ userId: { [Op.in]: ids } });
    if (f.userId) and.push({ userId: f.userId });
    if (f.leadId) and.push({ leadId: f.leadId });
    if (f.outcome) and.push({ outcome: f.outcome });
    if (f.from) and.push({ startedAt: { [Op.gte]: new Date(`${f.from}T00:00:00+04:00`) } });
    if (f.to) and.push({ startedAt: { [Op.lt]: new Date(new Date(`${f.to}T00:00:00+04:00`).getTime() + 86_400_000) } });
    const rows = (await u.repo("CallLog").findAll({ where: { [Op.and]: and }, order: [["startedAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })) as any[];
    const [users, contacts] = await Promise.all([
      u.repo("User").findAll({ where: { id: { [Op.in]: [...new Set(rows.map((r) => r.get("userId")))].concat(["-"]) } }, transaction: u.tx }),
      u.repo("Contact").findAll({ where: { id: { [Op.in]: [...new Set(rows.map((r) => r.get("contactId")))].concat(["-"]) } }, transaction: u.tx }),
    ]);
    const email = new Map((users as any[]).map((x) => [x.get("id"), x.get("email")]));
    const name = new Map((contacts as any[]).map((c) => [c.get("id"), [c.get("firstName"), c.get("lastName")].filter(Boolean).join(" ") || c.get("companyName") || c.get("email") || "Contact"]));
    return rows.map((r) => ({ ...plain(r), agent: email.get(r.get("userId")) ?? "Agent", contactName: name.get(r.get("contactId")) ?? "Contact" }));
  });
}

/** Per-agent call activity for a period: volume, answer rate, talk time and callbacks promised. */
export async function callStats(sq: Sequelize, ctx: RequestContext, o: { from: string; to: string }) {
  mustHave(ctx, "call.read");
  return withUow(sq, ctx, async (u) => {
    const ids = await visibleUserIds(u, ctx);
    const rows = await u.sq.query<{ user_id: string; calls: number; answered: number; talk: number; callbacks: number; inbound: number }>(
      `SELECT user_id, COUNT(*) AS calls, SUM(outcome='answered') AS answered, COALESCE(SUM(duration_sec),0) AS talk, SUM(outcome='callback_requested') AS callbacks, SUM(direction='inbound') AS inbound
         FROM call_logs WHERE tenant_id=:t AND started_at >= :s AND started_at < :e ${ids ? "AND user_id IN (:ids)" : ""} GROUP BY user_id ORDER BY calls DESC`,
      { replacements: { t: ctx.tenantId, s: mysqlDate(new Date(`${o.from}T00:00:00+04:00`)), e: mysqlDate(new Date(new Date(`${o.to}T00:00:00+04:00`).getTime() + 86_400_000)), ids: ids ?? [] }, transaction: u.tx, type: QueryTypes.SELECT },
    );
    const users = (await u.repo("User").findAll({ where: { id: { [Op.in]: rows.map((r) => r.user_id).concat(["-"]) } }, transaction: u.tx })) as any[];
    const email = new Map(users.map((x) => [x.get("id"), x.get("email") as string]));
    const agents = rows.map((r) => ({ userId: r.user_id, agent: email.get(r.user_id) ?? "Agent", calls: Number(r.calls), answered: Number(r.answered), answerRate: Number(r.calls) ? Number(r.answered) / Number(r.calls) : 0, talkMinutes: Math.round(Number(r.talk) / 60), avgSeconds: Number(r.answered) ? Math.round(Number(r.talk) / Number(r.answered)) : 0, callbacks: Number(r.callbacks), inbound: Number(r.inbound) }));
    const total = agents.reduce((a, r) => ({ calls: a.calls + r.calls, answered: a.answered + r.answered, talkMinutes: a.talkMinutes + r.talkMinutes }), { calls: 0, answered: 0, talkMinutes: 0 });
    return { from: o.from, to: o.to, agents, total: { ...total, answerRate: total.calls ? total.answered / total.calls : 0 } };
  });
}
