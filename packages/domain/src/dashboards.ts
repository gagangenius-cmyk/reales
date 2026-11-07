import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { hasPermission, widestScope } from "@reales/rbac";
import { DEAL_SCOPE } from "./deals";
import { dubaiDate } from "./hr";
import { LEAD_SCOPE } from "./leads";
import { LISTING_SCOPE } from "./listings";
import { scopeWhere } from "./scope";
import { targetProgress, type TargetProgress } from "./targets";
import { withUow } from "./uow";

const DAY = 86_400_000;
const OFFSET = 4 * 3_600_000; // Dubai is UTC+4 all year
/** Start of today in Dubai, as a real instant. */
const dubaiDayStart = (now = Date.now()) => new Date(Math.floor((now + OFFSET) / DAY) * DAY - OFFSET);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);

/** A manager sees more than their own records on leads (branch, business unit or whole company) or may assign leads. */
export function isManagerView(ctx: RequestContext): boolean {
  const s = widestScope(ctx, "lead.read");
  return s === "tenant" || s === "business_unit" || s === "branch" || ctx.grants.some((g) => g.permission === "lead.assign");
}

export interface Kpi { key: string; label: string; value: number; format?: "number" | "money" | "percent" | "minutes"; tone?: "good" | "warn" | "bad" | "neutral"; href?: string; hint?: string }
export interface AgendaItem { kind: "viewing" | "task" | "followup"; id: string; at: string; title: string; href: string; hot?: boolean }

// ---------------------------------------------------------------- agent: "my day"

/** Everything here is limited to records assigned to the caller, whatever their role, so a manager's "My day" is their own work only. */
export async function agentDashboard(sq: Sequelize, ctx: RequestContext) {
  const now = new Date();
  const todayStart = dubaiDayStart(), tomorrow = new Date(+todayStart + DAY), weekAhead = new Date(+todayStart + 7 * DAY);
  const monthStart = new Date(`${dubaiDate().slice(0, 7)}-01T00:00:00+04:00`);
  const weekAgo = new Date(+now - 7 * DAY), threeDaysAgo = new Date(+now - 3 * DAY);
  const canLeads = hasPermission(ctx, "lead.read"), canView = hasPermission(ctx, "viewing.read"), canDeals = hasPermission(ctx, "deal.read"), canList = hasPermission(ctx, "listing.read");

  return withUow(sq, ctx, async (u) => {
    const kpis: Kpi[] = [];
    const agenda: AgendaItem[] = [];
    const attention: { label: string; count: number; href: string; tone: "warn" | "bad" }[] = [];
    let funnel: { label: string; value: number }[] = [];
    let weekly: { label: string; value: number }[] = [];

    if (canLeads) {
      const mine = (await u.repo("Lead").findAll({ where: { assignedUserId: ctx.userId }, order: [["createdAt", "DESC"]], limit: 2000, transaction: u.tx })) as any[];
      const open = mine.filter((l) => l.get("status") === "open");
      const t = (v: unknown) => (v ? new Date(v as string).getTime() : null);
      const overdue = open.filter((l) => t(l.get("nextFollowUpAt")) !== null && t(l.get("nextFollowUpAt"))! < +now);
      const dueToday = open.filter((l) => { const f = t(l.get("nextFollowUpAt")); return f !== null && f >= +now && f < +tomorrow; });
      const hot = open.filter((l) => l.get("isHot"));
      const neverContacted = open.filter((l) => !l.get("firstResponseAt") && new Date(l.get("createdAt")).getTime() < +now - 3_600_000);
      const quiet = open.filter((l) => { const c = t(l.get("lastContactedAt")) ?? t(l.get("createdAt"))!; return c < +threeDaysAgo; });
      const wonMonth = mine.filter((l) => l.get("status") === "won" && t(l.get("updatedAt"))! >= +monthStart);
      const newWeek = mine.filter((l) => t(l.get("createdAt"))! >= +weekAgo);
      kpis.push(
        { key: "open", label: "My open leads", value: open.length, href: "/leads?assigned=me&status=open", tone: "neutral" },
        { key: "hot", label: "Hot leads", value: hot.length, href: "/leads?assigned=me&hot=1", tone: hot.length ? "warn" : "neutral" },
        { key: "overdue", label: "Overdue follow-ups", value: overdue.length, href: "/leads?assigned=me&followUp=overdue", tone: overdue.length ? "bad" : "good" },
        { key: "today", label: "Follow-ups today", value: dueToday.length, href: "/leads?assigned=me&followUp=today", tone: "neutral" },
        { key: "new", label: "New this week", value: newWeek.length, href: "/leads?assigned=me", tone: "neutral" },
        { key: "won", label: "Won this month", value: wonMonth.length, tone: "good" },
      );
      if (neverContacted.length) attention.push({ label: "Leads not yet contacted (over an hour old)", count: neverContacted.length, href: "/leads?assigned=me&status=open", tone: "bad" });
      if (quiet.length) attention.push({ label: "Open leads with no contact for 3+ days", count: quiet.length, href: "/leads?assigned=me&status=open", tone: "warn" });
      for (const l of [...overdue, ...dueToday].sort((a, b) => t(a.get("nextFollowUpAt"))! - t(b.get("nextFollowUpAt"))!).slice(0, 8))
        agenda.push({ kind: "followup", id: l.get("id"), at: new Date(l.get("nextFollowUpAt")).toISOString(), title: `Follow up: ${l.get("purpose")} lead`, href: `/leads/${l.get("id")}`, hot: !!l.get("isHot") });
      const stages = (await u.repo("PipelineStage").findAll({ order: [["position", "ASC"]], transaction: u.tx })) as any[];
      const name = new Map(stages.map((s) => [s.get("id"), s.get("name") as string]));
      const by = new Map<string, number>();
      for (const l of open) by.set(name.get(l.get("stageId")) ?? "Other", (by.get(name.get(l.get("stageId")) ?? "Other") ?? 0) + 1);
      funnel = [...new Set(stages.map((s) => s.get("name") as string))].map((label) => ({ label, value: by.get(label) ?? 0 }));
      weekly = Array.from({ length: 8 }, (_, i) => {
        const from = +now - (8 - i) * 7 * DAY, to = from + 7 * DAY;
        return { label: new Date(to).toISOString().slice(5, 10), value: mine.filter((l) => { const c = t(l.get("createdAt"))!; return c >= from && c < to; }).length };
      });
    }

    if (canView) {
      const v = (await u.repo("Viewing").findAll({ where: { agentUserId: ctx.userId, status: { [Op.in]: ["scheduled", "checked_in"] }, scheduledAt: { [Op.gte]: todayStart, [Op.lt]: weekAhead } }, order: [["scheduledAt", "ASC"]], limit: 50, transaction: u.tx })) as any[];
      const today = v.filter((x) => new Date(x.get("scheduledAt")) < tomorrow);
      kpis.push({ key: "viewings", label: "Viewings today", value: today.length, href: "/viewings", tone: "neutral", hint: `${v.length} in the next 7 days` });
      for (const x of today) agenda.push({ kind: "viewing", id: x.get("id"), at: new Date(x.get("scheduledAt")).toISOString(), title: `Viewing${x.get("locationNote") ? `: ${x.get("locationNote")}` : ""}`, href: "/viewings" });
    }

    const tasks = (await u.repo("Task").findAll({ where: { assigneeId: ctx.userId, status: "open", dueAt: { [Op.lt]: tomorrow } }, order: [["dueAt", "ASC"]], limit: 30, transaction: u.tx })) as any[];
    kpis.push({ key: "tasks", label: "Tasks due or overdue", value: tasks.length, href: "/tasks", tone: tasks.some((x) => new Date(x.get("dueAt")) < now) ? "warn" : "neutral" });
    for (const x of tasks.slice(0, 8)) agenda.push({ kind: "task", id: x.get("id"), at: new Date(x.get("dueAt")).toISOString(), title: String(x.get("title")), href: "/tasks" });

    if (canDeals) {
      const deals = (await u.repo("Deal").findAll({ where: { agentUserId: ctx.userId, status: "open" }, transaction: u.tx })) as any[];
      kpis.push({ key: "deals", label: "My open deals", value: deals.length, href: "/deals", tone: "neutral" });
      kpis.push({ key: "pipeline", label: "My pipeline (AED)", value: deals.reduce((a, d) => a + Number(d.get("amount") ?? 0), 0), format: "money", href: "/deals", tone: "neutral" });
    }
    if (hasPermission(ctx, "commission.read")) {
      const [c] = await u.sq.query<{ pending: string | null; payable: string | null }>(
        `SELECT SUM(CASE WHEN c.status='calculated' THEN s.amount END) AS pending, SUM(CASE WHEN c.status='approved' AND c.paid_at IS NULL THEN s.amount END) AS payable
           FROM commission_calculations c JOIN commission_splits s ON s.calculation_id=c.id AND s.tenant_id=c.tenant_id AND s.user_id=:u WHERE c.tenant_id=:t`,
        { replacements: { t: ctx.tenantId, u: ctx.userId }, transaction: u.tx, type: QueryTypes.SELECT });
      kpis.push({ key: "comm_pending", label: "Commission awaiting approval (AED)", value: Number(c?.pending ?? 0), format: "money", href: "/commissions", tone: "neutral" });
      kpis.push({ key: "comm_payable", label: "Commission ready to claim (AED)", value: Number(c?.payable ?? 0), format: "money", href: "/payouts", tone: Number(c?.payable ?? 0) > 0 ? "good" : "neutral" });
    }
    if (canList) {
      const soon = new Date(+now + 14 * DAY);
      const ls = (await u.repo("Listing").findAll({ where: { agentUserId: ctx.userId, status: "published" }, transaction: u.tx })) as any[];
      const expiring = ls.filter((l) => l.get("expiresOn") && new Date(l.get("expiresOn")) <= soon);
      kpis.push({ key: "listings", label: "My live listings", value: ls.length, href: "/listings?agent=me", tone: "neutral" });
      if (expiring.length) attention.push({ label: "My listings expiring within 14 days", count: expiring.length, href: "/listings", tone: "warn" });
    }
    agenda.sort((a, b) => a.at.localeCompare(b.at));
    let targets: TargetProgress[] = [];
    if (hasPermission(ctx, "target.read")) {
      targets = (await targetProgress(sq, ctx, { periodType: "month" }).catch(() => [] as TargetProgress[])).filter((x) => x.scopeType === "user" && x.scopeId === ctx.userId);
    }
    return { generatedAt: now.toISOString(), kpis, agenda, attention, funnel, weekly, targets };
  });
}

// ---------------------------------------------------------------- manager: team

/** Team and company view. Every figure is limited to the records the caller's grants allow (same scope rules as the lists). */
export async function teamDashboard(sq: Sequelize, ctx: RequestContext) {
  const now = new Date();
  const todayStart = dubaiDayStart();
  const monthStart = new Date(`${dubaiDate().slice(0, 7)}-01T00:00:00+04:00`);
  const prevMonthStart = new Date(monthStart); prevMonthStart.setUTCMonth(prevMonthStart.getUTCMonth() - 1);
  const weekAgo = new Date(+now - 7 * DAY);

  return withUow(sq, ctx, async (u) => {
    const kpis: Kpi[] = [];
    const attention: { label: string; count: number; href: string; tone: "warn" | "bad" }[] = [];
    const approvals: { label: string; count: number; href: string }[] = [];
    let funnel: { label: string; value: number }[] = [], sources: { label: string; leads: number; won: number }[] = [], weekly: { label: string; value: number }[] = [];
    let workload: { agent: string; open: number; hot: number; overdue: number; won: number; closedValue: number }[] = [];
    let dealStages: { label: string; value: number }[] = [];

    const emails = new Map(((await u.repo("User").findAll({ attributes: ["id", "email"], transaction: u.tx })) as any[]).map((x) => [x.get("id"), x.get("email") as string]));

    if (hasPermission(ctx, "lead.read")) {
      const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
      const [leads, stages, srcs] = await Promise.all([
        u.repo("Lead").findAll({ where: scope, order: [["createdAt", "DESC"]], limit: 5000, transaction: u.tx }) as Promise<any[]>,
        u.repo("PipelineStage").findAll({ order: [["position", "ASC"]], transaction: u.tx }) as Promise<any[]>,
        u.repo("LeadSource").findAll({ transaction: u.tx }) as Promise<any[]>,
      ]);
      const t = (v: unknown) => (v ? new Date(v as string).getTime() : null);
      const open = leads.filter((l) => l.get("status") === "open");
      const created = (from: Date, to?: Date) => leads.filter((l) => t(l.get("createdAt"))! >= +from && (!to || t(l.get("createdAt"))! < +to)).length;
      const unassigned = open.filter((l) => !l.get("assignedUserId"));
      const overdue = open.filter((l) => t(l.get("nextFollowUpAt")) !== null && t(l.get("nextFollowUpAt"))! < +now);
      const stale = open.filter((l) => (t(l.get("lastContactedAt")) ?? t(l.get("createdAt"))!) < +now - 7 * DAY);
      const slaBreach = open.filter((l) => !l.get("firstResponseAt") && t(l.get("createdAt"))! < +now - 3_600_000);
      const won = leads.filter((l) => l.get("status") === "won"), lost = leads.filter((l) => l.get("status") === "lost");
      const response = leads.filter((l) => l.get("firstResponseAt") && t(l.get("createdAt"))! >= +now - 30 * DAY).map((l) => (t(l.get("firstResponseAt"))! - t(l.get("createdAt"))!) / 60_000).filter((m) => m >= 0);
      const mNew = created(monthStart), pNew = created(prevMonthStart, monthStart);
      kpis.push(
        { key: "open", label: "Open leads", value: open.length, href: "/leads?status=open", tone: "neutral" },
        { key: "new_month", label: "New leads this month", value: mNew, href: "/leads", tone: mNew >= pNew ? "good" : "warn", hint: `${pNew} last month` },
        { key: "conv", label: "Win rate", value: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : 0, format: "percent", tone: "neutral" },
        { key: "resp", label: "Median first response (30d)", value: Math.round(median(response) ?? 0), format: "minutes", tone: (median(response) ?? 0) > 60 ? "warn" : "good" },
        { key: "unassigned", label: "Unassigned leads", value: unassigned.length, href: "/leads?assigned=unassigned", tone: unassigned.length ? "bad" : "good" },
        { key: "overdue", label: "Overdue follow-ups", value: overdue.length, href: "/leads?followUp=overdue", tone: overdue.length ? "bad" : "good" },
      );
      if (slaBreach.length) attention.push({ label: "New leads with no first response after 1 hour", count: slaBreach.length, href: "/leads?status=open", tone: "bad" });
      if (stale.length) attention.push({ label: "Open leads with no contact for 7+ days", count: stale.length, href: "/leads?status=open", tone: "warn" });
      const name = new Map(stages.map((s) => [s.get("id"), s.get("name") as string]));
      const byStage = new Map<string, number>();
      for (const l of open) byStage.set(name.get(l.get("stageId")) ?? "Other", (byStage.get(name.get(l.get("stageId")) ?? "Other") ?? 0) + 1);
      funnel = [...new Set(stages.map((s) => s.get("name") as string))].map((label) => ({ label, value: byStage.get(label) ?? 0 }));
      const srcName = new Map(srcs.map((s) => [s.get("id"), s.get("name") as string]));
      const bySrc = new Map<string, { leads: number; won: number }>();
      for (const l of leads) { const k = l.get("sourceId") ? srcName.get(l.get("sourceId")) ?? "Other" : "Unknown"; const e = bySrc.get(k) ?? { leads: 0, won: 0 }; e.leads++; if (l.get("status") === "won") e.won++; bySrc.set(k, e); }
      sources = [...bySrc.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.leads - a.leads).slice(0, 8);
      weekly = Array.from({ length: 12 }, (_, i) => { const from = +now - (12 - i) * 7 * DAY, to = from + 7 * DAY; return { label: new Date(to).toISOString().slice(5, 10), value: leads.filter((l) => { const c = t(l.get("createdAt"))!; return c >= from && c < to; }).length }; });
      const per = new Map<string, { open: number; hot: number; overdue: number; won: number }>();
      for (const l of leads) {
        const a = l.get("assignedUserId") as string | null; if (!a) continue;
        const e = per.get(a) ?? { open: 0, hot: 0, overdue: 0, won: 0 };
        if (l.get("status") === "open") { e.open++; if (l.get("isHot")) e.hot++; if (t(l.get("nextFollowUpAt")) !== null && t(l.get("nextFollowUpAt"))! < +now) e.overdue++; }
        if (l.get("status") === "won") e.won++;
        per.set(a, e);
      }
      workload = [...per.entries()].map(([id, v]) => ({ agent: emails.get(id) ?? "Agent", ...v, closedValue: 0, _id: id } as any)).sort((a, b) => b.open - a.open).slice(0, 15);
    }

    if (hasPermission(ctx, "deal.read")) {
      const scope = await scopeWhere(u, ctx, "deal.read", DEAL_SCOPE);
      const deals = (await u.repo("Deal").findAll({ where: scope, limit: 5000, transaction: u.tx })) as any[];
      const open = deals.filter((d) => d.get("status") === "open");
      const closedMonth = deals.filter((d) => d.get("stage") === "closed" && d.get("closedAt") && new Date(d.get("closedAt")) >= monthStart);
      const closedPrev = deals.filter((d) => d.get("stage") === "closed" && d.get("closedAt") && new Date(d.get("closedAt")) >= prevMonthStart && new Date(d.get("closedAt")) < monthStart);
      const sum = (xs: any[]) => xs.reduce((a, d) => a + Number(d.get("amount") ?? 0), 0);
      kpis.push(
        { key: "pipeline", label: "Open pipeline (AED)", value: sum(open), format: "money", href: "/deals", tone: "neutral", hint: `${open.length} deals` },
        { key: "closed_month", label: "Closed this month (AED)", value: sum(closedMonth), format: "money", tone: sum(closedMonth) >= sum(closedPrev) ? "good" : "warn", hint: `${closedMonth.length} deals; last month ${Math.round(sum(closedPrev)).toLocaleString("en-US")}` },
      );
      const by = new Map<string, number>();
      for (const d of open) by.set(String(d.get("stage")), (by.get(String(d.get("stage"))) ?? 0) + 1);
      dealStages = ["reserved", "contract", "signed", "payment", "registration"].map((label) => ({ label, value: by.get(label) ?? 0 }));
      const closedBy = new Map<string, number>();
      for (const d of closedMonth) closedBy.set(d.get("agentUserId"), (closedBy.get(d.get("agentUserId")) ?? 0) + Number(d.get("amount") ?? 0));
      workload = workload.map((w: any) => ({ agent: w.agent, open: w.open, hot: w.hot, overdue: w.overdue, won: w.won, closedValue: closedBy.get(w._id) ?? 0 }));
      const stuck = open.filter((d) => new Date(d.get("updatedAt")).getTime() < +now - 14 * DAY);
      if (stuck.length) attention.push({ label: "Open deals with no movement for 14+ days", count: stuck.length, href: "/deals?status=open", tone: "warn" });
    }

    if (hasPermission(ctx, "listing.read")) {
      const scope = await scopeWhere(u, ctx, "listing.read", LISTING_SCOPE);
      const live = (await u.repo("Listing").findAll({ where: { [Op.and]: [scope, { status: "published" }] }, limit: 5000, transaction: u.tx })) as any[];
      const soon = new Date(+now + 14 * DAY);
      const expiring = live.filter((l) => l.get("expiresOn") && new Date(l.get("expiresOn")) <= soon);
      kpis.push({ key: "listings", label: "Live listings", value: live.length, href: "/listings", tone: "neutral" });
      if (expiring.length) attention.push({ label: "Listings expiring within 14 days", count: expiring.length, href: "/listings", tone: "warn" });
    }

    // Decisions waiting on this person (only shown when they hold the permission to act).
    const one = async (sql: string) => Number(((await u.sq.query<{ n: number }>(sql, { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT }).catch(() => [{ n: 0 }]))[0]?.n) ?? 0);
    if (hasPermission(ctx, "commission.approve")) {
      approvals.push({ label: "Commissions awaiting approval", count: await one("SELECT COUNT(*) n FROM commission_calculations WHERE tenant_id=:t AND status='calculated'"), href: "/commissions" });
      approvals.push({ label: "Payout requests to decide", count: await one("SELECT COUNT(*) n FROM payout_requests WHERE tenant_id=:t AND status IN ('pending','approved')"), href: "/payouts" });
    }
    if (hasPermission(ctx, "claim.verify")) approvals.push({ label: "Claim batches to verify", count: await one("SELECT COUNT(*) n FROM commission_claim_batches WHERE tenant_id=:t AND status='submitted'"), href: "/claims" });
    if (hasPermission(ctx, "claim.approve")) approvals.push({ label: "Claim batches to approve", count: await one("SELECT COUNT(*) n FROM commission_claim_batches WHERE tenant_id=:t AND status IN ('verified','approved')"), href: "/claims" });
    if (hasPermission(ctx, "claim.release")) approvals.push({ label: "Claim batches due for release", count: await one(`SELECT COUNT(*) n FROM commission_claim_batches WHERE tenant_id=:t AND status='scheduled' AND scheduled_for <= '${dubaiDate()}'`), href: "/claims" });
    if (hasPermission(ctx, "photoshoot.manage")) approvals.push({ label: "Photoshoot requests to schedule", count: await one("SELECT COUNT(*) n FROM photoshoot_requests WHERE tenant_id=:t AND status='requested'"), href: "/photoshoots" });
    if (hasPermission(ctx, "hr.leave.approve")) approvals.push({ label: "Leave requests pending", count: await one("SELECT COUNT(*) n FROM hr_leave_requests WHERE tenant_id=:t AND status='pending'"), href: "/hr/leave" });
    if (hasPermission(ctx, "kyc.review")) approvals.push({ label: "KYC profiles to review", count: await one("SELECT COUNT(*) n FROM kyc_profiles WHERE tenant_id=:t AND status='in_review'"), href: "/compliance" });

    let targets: TargetProgress[] = [];
    if (hasPermission(ctx, "target.read")) targets = (await targetProgress(sq, ctx, { periodType: "month" }).catch(() => [] as TargetProgress[])).filter((x) => x.scopeType !== "user").slice(0, 8);
    return { generatedAt: now.toISOString(), since: mysqlDate(todayStart), kpis, attention, approvals: approvals.filter((a) => a.count > 0), funnel, sources, weekly, workload, dealStages, targets };
  });
}
