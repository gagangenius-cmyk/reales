import { Op, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { ForbiddenError, hasPermission } from "@reales/rbac";
import { LEAD_SCOPE } from "./leads";
import { DEAL_SCOPE } from "./deals";
import { scopeWhere } from "./scope";
import { withUow } from "./uow";

const WEEK = 7 * 86_400_000;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);

/**
 * Analytics for the Insights page: funnel, sources and campaigns, weekly intake, agent leaderboard, response time, loss reasons, deal pipeline and
 * inventory. Every figure comes from rows the caller may see (same scope rules as the lists), capped at 5000 leads / 5000 deals.
 */
export async function insightsOverview(sq: Sequelize, ctx: RequestContext, weeks = 12) {
  if (!hasPermission(ctx, "analytics.read")) throw new ForbiddenError("Missing permission: analytics.read");
  return withUow(sq, ctx, async (u) => {
    const now = Date.now();
    const out: Record<string, unknown> = { generatedAt: new Date(now).toISOString(), weeks };

    if (hasPermission(ctx, "lead.read")) {
      const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
      const [leads, stages, sources, users] = await Promise.all([
        u.repo("Lead").findAll({ where: scope, order: [["createdAt", "DESC"]], limit: 5000, transaction: u.tx }),
        u.repo("PipelineStage").findAll({ order: [["position", "ASC"]], transaction: u.tx }),
        u.repo("LeadSource").findAll({ transaction: u.tx }),
        u.repo("User").findAll({ transaction: u.tx }),
      ]);
      const L = (leads as any[]).map((l) => ({
        id: l.get("id"), created: new Date(l.get("createdAt")).getTime(), status: l.get("status") as string, stage: l.get("stageId") as string, source: l.get("sourceId") as string | null,
        campaign: (l.get("campaign") as string | null) ?? null, agent: l.get("assignedUserId") as string | null, hot: !!l.get("isHot"), first: l.get("firstResponseAt") ? new Date(l.get("firstResponseAt")).getTime() : null,
        lost: (l.get("lostReason") as string | null) ?? null, budget: l.get("budgetMax") ? Number(l.get("budgetMax")) : 0, followUp: l.get("nextFollowUpAt") ? new Date(l.get("nextFollowUpAt")).getTime() : null,
      }));
      const stageName = new Map((stages as any[]).map((s) => [s.get("id"), s.get("name") as string]));
      const sourceName = new Map((sources as any[]).map((s) => [s.get("id"), s.get("name") as string]));
      const email = new Map((users as any[]).map((x) => [x.get("id"), x.get("email") as string]));
      const stageOrder = [...new Set((stages as any[]).map((s) => s.get("name") as string))];

      const count = <T,>(xs: T[], key: (x: T) => string) => { const m = new Map<string, number>(); for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1); return m; };
      const funnelMap = count(L, (l) => stageName.get(l.stage) ?? "Unknown");
      out.funnel = stageOrder.map((name) => ({ label: name, value: funnelMap.get(name) ?? 0 }));

      const bySource = new Map<string, { leads: number; won: number }>();
      for (const l of L) { const k = l.source ? sourceName.get(l.source) ?? "Other" : "Unknown"; const e = bySource.get(k) ?? { leads: 0, won: 0 }; e.leads++; if (l.status === "won") e.won++; bySource.set(k, e); }
      out.sources = [...bySource.entries()].map(([label, v]) => ({ label, leads: v.leads, won: v.won, winRate: v.leads ? v.won / v.leads : 0 })).sort((a, b) => b.leads - a.leads);

      const byCampaign = new Map<string, { leads: number; won: number; pipeline: number }>();
      for (const l of L) if (l.campaign) { const e = byCampaign.get(l.campaign) ?? { leads: 0, won: 0, pipeline: 0 }; e.leads++; if (l.status === "won") e.won++; if (l.status === "open") e.pipeline += l.budget; byCampaign.set(l.campaign, e); }
      out.campaigns = [...byCampaign.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.leads - a.leads).slice(0, 10);

      const start = now - weeks * WEEK;
      const weekly = Array.from({ length: weeks }, (_, i) => ({ label: new Date(start + (i + 1) * WEEK).toISOString().slice(5, 10), value: 0 }));
      for (const l of L) { const i = Math.floor((l.created - start) / WEEK); if (i >= 0 && i < weeks) weekly[i]!.value++; }
      out.weeklyIntake = weekly;

      const byAgent = new Map<string, { open: number; won: number; lost: number; hot: number }>();
      for (const l of L) if (l.agent) { const e = byAgent.get(l.agent) ?? { open: 0, won: 0, lost: 0, hot: 0 }; if (l.status === "open") { e.open++; if (l.hot) e.hot++; } else if (l.status === "won") e.won++; else e.lost++; byAgent.set(l.agent, e); }
      out.agents = [...byAgent.entries()].map(([id, v]) => ({ agent: email.get(id) ?? "Agent", ...v, winRate: v.won + v.lost ? v.won / (v.won + v.lost) : null })).sort((a, b) => b.won - a.won || b.open - a.open).slice(0, 15);

      const resp = L.filter((l) => l.first).map((l) => (l.first! - l.created) / 60_000).filter((m) => m >= 0);
      out.response = { medianMinutes: median(resp) === null ? null : Math.round(median(resp)!), within15: resp.length ? resp.filter((m) => m <= 15).length / resp.length : null, measured: resp.length, neverAnswered: L.filter((l) => l.status === "open" && !l.first).length };

      const lostMap = count(L.filter((l) => l.status === "lost"), (l) => (l.lost ?? "No reason").slice(0, 60));
      out.lossReasons = [...lostMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);

      const open = L.filter((l) => l.status === "open");
      out.leadTotals = { total: L.length, open: open.length, won: L.filter((l) => l.status === "won").length, lost: L.filter((l) => l.status === "lost").length, hot: open.filter((l) => l.hot).length, overdueFollowUps: open.filter((l) => l.followUp && l.followUp < now).length, unassigned: open.filter((l) => !l.agent).length, openBudget: open.reduce((a, l) => a + l.budget, 0) };
    }

    if (hasPermission(ctx, "deal.read")) {
      const scope = await scopeWhere(u, ctx, "deal.read", DEAL_SCOPE);
      const deals = (await u.repo("Deal").findAll({ where: scope, limit: 5000, transaction: u.tx })) as any[];
      const stageSum = new Map<string, { n: number; value: number }>();
      for (const d of deals) { const k = String(d.get("stage")); const e = stageSum.get(k) ?? { n: 0, value: 0 }; e.n++; e.value += Number(d.get("amount") ?? 0); stageSum.set(k, e); }
      out.dealStages = [...stageSum.entries()].map(([label, v]) => ({ label: label.replace(/_/g, " "), value: v.n, amount: v.value }));
      const closed = deals.filter((d) => d.get("stage") === "closed");
      out.dealTotals = { total: deals.length, closed: closed.length, closedValue: closed.reduce((a, d) => a + Number(d.get("amount") ?? 0), 0), pipelineValue: deals.filter((d) => d.get("status") === "open").reduce((a, d) => a + Number(d.get("amount") ?? 0), 0) };
    }

    if (hasPermission(ctx, "inventory.read") || hasPermission(ctx, "inventory.manage")) {
      const units = (await u.repo("Unit").findAll({ limit: 5000, transaction: u.tx })) as any[];
      const m = new Map<string, number>(); for (const x of units) m.set(x.get("status"), (m.get(x.get("status")) ?? 0) + 1);
      out.inventory = ["available", "reserved", "sold", "rented", "blocked"].map((label) => ({ label, value: m.get(label) ?? 0 }));
    }
    if (hasPermission(ctx, "listing.read")) {
      const listings = (await u.repo("Listing").findAll({ where: { status: "published" }, limit: 5000, transaction: u.tx })) as any[];
      const buckets = [["0-30 days", 0], ["31-60 days", 0], ["61-90 days", 0], ["90+ days", 0]] as [string, number][];
      for (const l of listings) { const age = (now - new Date(l.get("publishedAt") ?? l.get("createdAt")).getTime()) / 86_400_000; buckets[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3]![1]++; }
      out.listingAge = buckets.map(([label, value]) => ({ label, value }));
    }
    void Op;
    return out;
  });
}
