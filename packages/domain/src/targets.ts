import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { ForbiddenError, hasPermission, widestScope } from "@reales/rbac";
import { plain } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

export const TARGET_METRICS = ["closed_value", "closed_deals", "new_leads", "viewings_done"] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];
export type TargetScope = "user" | "team" | "branch" | "tenant";
export type TargetPeriod = "month" | "quarter" | "year";

const OFFSET = 4 * 3_600_000; // Dubai, no DST
/** First day (YYYY-MM-DD) of the period that contains `date`, and the first day after it. */
export function periodBounds(type: TargetPeriod, date: string) {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  const startMonth = type === "month" ? m : type === "quarter" ? Math.floor((m - 1) / 3) * 3 + 1 : 1;
  const months = type === "month" ? 1 : type === "quarter" ? 3 : 12;
  const iso = (yy: number, mm: number) => `${yy + Math.floor((mm - 1) / 12)}-${String(((mm - 1) % 12) + 1).padStart(2, "0")}-01`;
  return { start: iso(y, startMonth), end: iso(y, startMonth + months) };
}
const toUtc = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - OFFSET);

export interface TargetInput { scopeType: TargetScope; scopeId?: string | null; periodType: TargetPeriod; periodStart: string; metric: TargetMetric; targetValue: number; note?: string }

/** Create or replace one target. Branch managers may set targets for their own branch, its teams and its people; tenant-wide targets need tenant scope. */
const mustManage = (ctx: RequestContext) => { if (!hasPermission(ctx, "target.manage")) throw new ForbiddenError("Missing permission: target.manage"); };

export async function setTarget(sq: Sequelize, ctx: RequestContext, i: TargetInput) {
  mustManage(ctx); // row-scoped grants (branch) cannot be checked without a resource; the branch limits below do that
  if (!(i.targetValue > 0)) throw new ConflictError("A target must be above zero");
  if (!TARGET_METRICS.includes(i.metric)) throw new ConflictError("Unknown metric");
  if (i.scopeType === "tenant" ? !!i.scopeId : !i.scopeId) throw new ConflictError(i.scopeType === "tenant" ? "A workspace target has no scope id" : "Choose who the target is for");
  const { start } = periodBounds(i.periodType, i.periodStart);
  const wide = widestScope(ctx, "target.manage");
  if (wide !== "tenant" && (i.scopeType === "tenant")) throw new ConflictError("Only tenant-wide managers can set a workspace target");
  return withUow(sq, ctx, async (u) => {
    if (i.scopeType === "user" && !(await u.repo("User").findById(i.scopeId!, { transaction: u.tx }))) throw new NotFoundError("User");
    if (i.scopeType === "team" && !(await u.repo("Team").findById(i.scopeId!, { transaction: u.tx }))) throw new NotFoundError("Team");
    if (i.scopeType === "branch" && !(await u.repo("Branch").findById(i.scopeId!, { transaction: u.tx }))) throw new NotFoundError("Branch");
    if (wide !== "tenant") {
      const branchIds = ctx.membership.branchIds;
      let ok = false;
      if (i.scopeType === "branch") ok = branchIds.includes(i.scopeId!);
      if (i.scopeType === "user") ok = !!(await u.repo("User").findOne({ where: { id: i.scopeId!, branchId: { [Op.in]: branchIds.length ? branchIds : ["-"] } }, transaction: u.tx })) || i.scopeId === ctx.userId;
      if (i.scopeType === "team") ok = !!(await u.repo("Team").findOne({ where: { id: i.scopeId!, branchId: { [Op.in]: branchIds.length ? branchIds : ["-"] } }, transaction: u.tx }));
      if (!ok) throw new ConflictError("You can only set targets inside your own branch");
    }
    const existing: any = await u.repo("SalesTarget").findOne({ where: { scopeType: i.scopeType, scopeId: i.scopeId ?? null, periodType: i.periodType, periodStart: start, metric: i.metric }, transaction: u.tx });
    let id: string;
    if (existing) { id = existing.get("id"); await u.repo("SalesTarget").updateById(id, { targetValue: i.targetValue, note: i.note ?? null }, { transaction: u.tx }); }
    else { id = randomUUID(); await u.repo("SalesTarget").create({ id, scopeType: i.scopeType, scopeId: i.scopeId ?? null, periodType: i.periodType, periodStart: start, metric: i.metric, targetValue: i.targetValue, note: i.note ?? null, createdBy: ctx.userId }, { transaction: u.tx }); }
    await u.audit({ action: existing ? "target.updated" : "target.created", entityType: "sales_target", entityId: id, before: existing ? { targetValue: existing.get("targetValue") } : undefined, after: { ...i, periodStart: start } });
    return plain(await u.repo("SalesTarget").findById(id, { transaction: u.tx }));
  });
}

export async function deleteTarget(sq: Sequelize, ctx: RequestContext, id: string) {
  mustManage(ctx);
  return withUow(sq, ctx, async (u) => {
    const t: any = await u.repo("SalesTarget").findById(id, { transaction: u.tx });
    if (!t) throw new NotFoundError("Target");
    await u.repo("SalesTarget").deleteById(id, { transaction: u.tx });
    await u.audit({ action: "target.deleted", entityType: "sales_target", entityId: id, before: { metric: t.get("metric"), targetValue: t.get("targetValue") } });
  });
}

/** Actual value of one metric for a set of people inside [start, end). */
async function actual(sq: Sequelize, tenantId: string, metric: TargetMetric, userIds: string[] | null, start: Date, end: Date, tx?: unknown) {
  const user = userIds ? (userIds.length ? "AND {col} IN (:ids)" : "AND 1=0") : "";
  const q = async (sql: string, col: string) => {
    const [r] = await sq.query<{ v: string | null }>(sql.replace("{user}", user.replace("{col}", col)), { replacements: { t: tenantId, s: mysqlDate(start), e: mysqlDate(end), ids: userIds ?? [] }, transaction: tx as never, type: QueryTypes.SELECT });
    return Number(r?.v ?? 0);
  };
  if (metric === "closed_value") return q("SELECT COALESCE(SUM(amount),0) AS v FROM deals WHERE tenant_id=:t AND stage='closed' AND closed_at >= :s AND closed_at < :e {user}", "agent_user_id");
  if (metric === "closed_deals") return q("SELECT COUNT(*) AS v FROM deals WHERE tenant_id=:t AND stage='closed' AND closed_at >= :s AND closed_at < :e {user}", "agent_user_id");
  if (metric === "new_leads") return q("SELECT COUNT(*) AS v FROM leads WHERE tenant_id=:t AND deleted_at IS NULL AND created_at >= :s AND created_at < :e {user}", "assigned_user_id");
  return q("SELECT COUNT(*) AS v FROM viewings WHERE tenant_id=:t AND status='completed' AND completed_at >= :s AND completed_at < :e {user}", "agent_user_id");
}

export interface TargetProgress {
  id: string; scopeType: TargetScope; scopeId: string | null; scopeName: string; metric: TargetMetric; periodType: TargetPeriod; periodStart: string; periodEnd: string;
  target: number; actual: number; pct: number; expectedPct: number; status: "ahead" | "on_track" | "behind" | "achieved"; note: string | null;
}

/**
 * Targets for the period containing `date` with actual progress. `expectedPct` is how far through the period we are, so "behind" means
 * progress is more than 10 points under the calendar. Visibility: tenant scope sees all; others see their own, their teams', and their branch's.
 */
export async function targetProgress(sq: Sequelize, ctx: RequestContext, o: { periodType: TargetPeriod; date?: string }): Promise<TargetProgress[]> {
  if (!hasPermission(ctx, "target.read")) throw new ForbiddenError("Missing permission: target.read");
  const day = o.date ?? new Date(Date.now() + OFFSET).toISOString().slice(0, 10);
  const { start, end } = periodBounds(o.periodType, day);
  const from = toUtc(start), to = toUtc(end);
  const elapsed = Math.min(1, Math.max(0, (Date.now() - from.getTime()) / (to.getTime() - from.getTime())));
  const wide = widestScope(ctx, "target.read");
  return withUow(sq, ctx, async (u) => {
    const rows = (await u.repo("SalesTarget").findAll({ where: { periodType: o.periodType, periodStart: start }, transaction: u.tx })) as any[];
    const [teams, members, branches, users] = await Promise.all([
      u.repo("Team").findAll({ transaction: u.tx }), u.repo("TeamMember").findAll({ transaction: u.tx }), u.repo("Branch").findAll({ transaction: u.tx }), u.repo("User").findAll({ transaction: u.tx }),
    ]);
    const myTeams = new Set((members as any[]).filter((m) => m.get("userId") === ctx.userId).map((m) => m.get("teamId")));
    const teamName = new Map((teams as any[]).map((t) => [t.get("id"), t.get("name") as string]));
    const branchName = new Map((branches as any[]).map((b) => [b.get("id"), b.get("name") as string]));
    const email = new Map((users as any[]).map((x) => [x.get("id"), x.get("email") as string]));
    const teamUsers = (id: string) => (members as any[]).filter((m) => m.get("teamId") === id).map((m) => m.get("userId") as string);
    const branchUsers = (id: string) => (users as any[]).filter((x) => x.get("branchId") === id).map((x) => x.get("id") as string);

    const visible = rows.filter((r) => {
      if (wide === "tenant") return true;
      const t = r.get("scopeType"), id = r.get("scopeId");
      if (t === "user") return id === ctx.userId || (wide === "branch" && ctx.membership.branchIds.includes((users as any[]).find((x) => x.get("id") === id)?.get("branchId")));
      if (t === "team") return myTeams.has(id) || (wide === "branch" && ctx.membership.branchIds.includes((teams as any[]).find((x) => x.get("id") === id)?.get("branchId")));
      if (t === "branch") return ctx.membership.branchIds.includes(id);
      return t === "tenant";
    });
    const out: TargetProgress[] = [];
    for (const r of visible) {
      const t = r.get("scopeType") as TargetScope, id = (r.get("scopeId") as string | null) ?? null;
      const ids = t === "user" ? [id!] : t === "team" ? teamUsers(id!) : t === "branch" ? branchUsers(id!) : null;
      const metric = r.get("metric") as TargetMetric;
      const value = await actual(sq, ctx.tenantId, metric, ids, from, to, u.tx);
      const target = Number(r.get("targetValue"));
      const pct = target ? value / target : 0;
      out.push({
        id: r.get("id"), scopeType: t, scopeId: id, scopeName: t === "user" ? email.get(id!) ?? "User" : t === "team" ? teamName.get(id!) ?? "Team" : t === "branch" ? branchName.get(id!) ?? "Branch" : "Whole company",
        metric, periodType: o.periodType, periodStart: start, periodEnd: end, target, actual: value, pct, expectedPct: elapsed,
        status: pct >= 1 ? "achieved" : pct + 0.1 < elapsed ? "behind" : pct >= elapsed ? "ahead" : "on_track", note: r.get("note") ?? null,
      });
    }
    return out.sort((a, b) => a.scopeType.localeCompare(b.scopeType) || a.scopeName.localeCompare(b.scopeName));
  });
}
