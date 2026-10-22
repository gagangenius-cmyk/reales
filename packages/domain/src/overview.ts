import { Op, QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { ForbiddenError, hasPermission } from "@reales/rbac";
import { listingQuality } from "./listing-details";
import { LEAD_SCOPE } from "./leads";
import { LISTING_SCOPE } from "./listings";
import { scopeWhere } from "./scope";
import { withUow } from "./uow";

const DAY = 86_400_000;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
const count = <T,>(xs: T[], key: (x: T) => string | null | undefined) => { const m = new Map<string, number>(); for (const x of xs) { const k = key(x) ?? "Unknown"; m.set(k, (m.get(k) ?? 0) + 1); } return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value); };
const band = (n: number, edges: number[], fmt: (e: number) => string) => { const i = edges.findIndex((e) => n < e); return i === -1 ? `${fmt(edges[edges.length - 1]!)}+` : i === 0 ? `Under ${fmt(edges[0]!)}` : `${fmt(edges[i - 1]!)} to ${fmt(edges[i]!)}`; };
const k = (e: number) => (e >= 1_000_000 ? `${e / 1_000_000}M` : `${e / 1000}K`);

/**
 * One-screen picture of the leads the caller can see: totals and week-on-week change, speed of response, where leads come from, where they sit in the
 * pipeline, who holds them, and the short lists that need action today. Computed from the same scoped rows as the lead list (up to 5000 newest).
 */
export interface LeadBrief { id: string; stage: string; purpose: string; hot: boolean; agent: string | null; followUp: string | null; created: string }

export async function leadsOverview(sq: Sequelize, ctx: RequestContext) {
  if (!hasPermission(ctx, "lead.read")) throw new ForbiddenError("Missing permission: lead.read");
  return withUow(sq, ctx, async (u) => {
    const now = Date.now();
    const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
    const [leads, stages, sources, users] = await Promise.all([
      u.repo("Lead").findAll({ where: scope, order: [["createdAt", "DESC"]], limit: 5000, transaction: u.tx }),
      u.repo("PipelineStage").findAll({ order: [["position", "ASC"]], transaction: u.tx }),
      u.repo("LeadSource").findAll({ transaction: u.tx }), u.repo("User").findAll({ transaction: u.tx }),
      u.repo("Contact").findAll({ where: { createdAt: { [Op.gte]: new Date(now - 30 * DAY) } }, attributes: ["id"], limit: 1, transaction: u.tx }),
    ]);
    const stageName = new Map((stages as any[]).map((s) => [s.get("id"), s.get("name") as string]));
    const stageOrder = [...new Set((stages as any[]).map((s) => s.get("name") as string))];
    const sourceName = new Map((sources as any[]).map((s) => [s.get("id"), s.get("name") as string]));
    const email = new Map((users as any[]).map((x) => [x.get("id"), x.get("email") as string]));
    const L = (leads as any[]).map((l) => ({
      id: l.get("id"), created: new Date(l.get("createdAt")).getTime(), status: l.get("status") as string, stage: stageName.get(l.get("stageId")) ?? "Unknown", source: l.get("sourceId") ? sourceName.get(l.get("sourceId")) ?? "Other" : "Unknown", campaign: l.get("campaign") as string | null,
      purpose: l.get("purpose") as string, hot: !!l.get("isHot"), agent: l.get("assignedUserId") as string | null, budget: l.get("budgetMax") ? Number(l.get("budgetMax")) : null, language: l.get("language") as string | null,
      first: l.get("firstResponseAt") ? new Date(l.get("firstResponseAt")).getTime() : null, last: l.get("lastContactedAt") ? new Date(l.get("lastContactedAt")).getTime() : null,
      followUp: l.get("nextFollowUpAt") ? new Date(l.get("nextFollowUpAt")).getTime() : null, pool: !!l.get("poolId"), financing: l.get("financing") as string | null, timeline: l.get("purchaseTimeline") as string | null, tags: Array.isArray(l.get("tags")) ? (l.get("tags") as string[]) : [],
    }));
    const open = L.filter((l) => l.status === "open"), won = L.filter((l) => l.status === "won"), lost = L.filter((l) => l.status === "lost");
    const inRange = (a: number, b: number) => L.filter((l) => l.created >= now - a * DAY && l.created < now - b * DAY).length;
    const thisWeek = inRange(7, 0), lastWeek = inRange(14, 7);
    const resp = L.filter((l) => l.first).map((l) => (l.first! - l.created) / 60_000).filter((m) => m >= 0);
    const dayKey = (t: number) => new Date(t + 4 * 3_600_000).toISOString().slice(0, 10);
    const perDay = new Map<string, number>(); for (const l of L) perDay.set(dayKey(l.created), (perDay.get(dayKey(l.created)) ?? 0) + 1);
    const intake = Array.from({ length: 30 }, (_, i) => { const key = dayKey(now - (29 - i) * DAY); return { label: key.slice(5), value: perDay.get(key) ?? 0 }; });
    const bySource = count(L, (l) => l.source).slice(0, 8).map((s) => { const all = L.filter((l) => l.source === s.label); return { ...s, won: all.filter((l) => l.status === "won").length }; });
    const stageCounts = count(open, (l) => l.stage);
    const attention = {
      overdue: open.filter((l) => l.followUp && l.followUp < now).sort((a, b) => a.followUp! - b.followUp!).slice(0, 8),
      unassigned: open.filter((l) => !l.agent && !l.pool).slice(0, 8),
      hotUntouched: open.filter((l) => l.hot && (!l.last || l.last < now - 2 * DAY)).slice(0, 8),
      stale: open.filter((l) => l.created < now - 7 * DAY && (!l.last || l.last < now - 7 * DAY)).slice(0, 8),
    };
    const brief = (l: (typeof L)[number]): LeadBrief => ({ id: l.id, stage: l.stage, purpose: l.purpose, hot: l.hot, agent: l.agent ? email.get(l.agent) ?? "Agent" : null, followUp: l.followUp ? new Date(l.followUp).toISOString() : null, created: new Date(l.created).toISOString() });
    return {
      generatedAt: new Date(now).toISOString(),
      totals: { all: L.length, open: open.length, won: won.length, lost: lost.length, hot: open.filter((l) => l.hot).length, unassigned: open.filter((l) => !l.agent && !l.pool).length, inPool: open.filter((l) => l.pool && !l.agent).length, overdue: open.filter((l) => l.followUp && l.followUp < now).length, neverContacted: open.filter((l) => !l.last && !l.first).length, openBudget: open.reduce((a, l) => a + (l.budget ?? 0), 0), winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null },
      trend: { thisWeek, lastWeek, change: lastWeek ? (thisWeek - lastWeek) / lastWeek : null },
      response: { medianMinutes: median(resp) === null ? null : Math.round(median(resp)!), within15: resp.length ? resp.filter((m) => m <= 15).length / resp.length : null, measured: resp.length },
      intake, funnel: stageOrder.map((label) => ({ label, value: stageCounts.find((s) => s.label === label)?.value ?? 0 })),
      sources: bySource, purposes: count(L, (l) => l.purpose), campaigns: count(L.filter((l) => l.campaign), (l) => l.campaign).slice(0, 8),
      budgets: count(open.filter((l) => l.budget), (l) => band(l.budget!, [500_000, 1_000_000, 2_000_000, 5_000_000], k)), languages: count(L, (l) => l.language ?? "Unknown").slice(0, 6),
      financing: count(open.filter((l) => l.financing), (l) => l.financing), timelines: count(open.filter((l) => l.timeline), (l) => l.timeline),
      workload: count(open.filter((l) => l.agent), (l) => email.get(l.agent!) ?? "Agent").slice(0, 10),
      tags: count(open.flatMap((l) => l.tags.map((t) => ({ t }))), (x) => x.t).slice(0, 10),
      attention: { overdue: attention.overdue.map(brief), unassigned: attention.unassigned.map(brief), hotUntouched: attention.hotUntouched.map(brief), stale: attention.stale.map(brief) },
    };
  });
}

/** The same one-screen view for listings: status mix, market time, what needs fixing (no photos, permit, expiry), and what is performing. */
export async function listingsOverview(sq: Sequelize, ctx: RequestContext) {
  if (!hasPermission(ctx, "listing.read")) throw new ForbiddenError("Missing permission: listing.read");
  return withUow(sq, ctx, async (u) => {
    const now = Date.now(), today = new Date(now).toISOString().slice(0, 10);
    const scope = await scopeWhere(u, ctx, "listing.read", LISTING_SCOPE);
    const listings = (await u.repo("Listing").findAll({ where: scope, order: [["createdAt", "DESC"]], limit: 5000, transaction: u.tx })) as any[];
    const ids = listings.map((l) => l.get("id") as string);
    const [units, buildings, media, permits] = await Promise.all([
      u.repo("Unit").findAll({ where: { id: { [Op.in]: listings.map((l) => l.get("unitId")).concat(["-"]) } }, transaction: u.tx }),
      u.repo("Building").findAll({ transaction: u.tx }),
      ids.length ? u.sq.query<{ listing_id: string; kind: string; n: number }>("SELECT listing_id, kind, COUNT(*) AS n FROM listing_media WHERE tenant_id=:t GROUP BY listing_id, kind", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT }) : Promise.resolve([]),
      ids.length ? u.sq.query<{ listing_id: string; status: string; expires_at: string }>("SELECT listing_id, status, expires_at FROM listing_permits WHERE tenant_id=:t", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT }) : Promise.resolve([]),
    ]);
    const unitBy = new Map((units as any[]).map((x) => [x.get("id"), x])), bBy = new Map((buildings as any[]).map((b) => [b.get("id"), b]));
    const photos = new Map<string, number>(), plans = new Set<string>();
    for (const m of media) { if (m.kind === "image") photos.set(m.listing_id, Number(m.n)); if (m.kind === "floorplan") plans.add(m.listing_id); }
    const validPermit = new Set(permits.filter((p) => p.status === "valid" && String(p.expires_at) >= today).map((p) => p.listing_id));
    const expiringPermit = new Set(permits.filter((p) => p.status === "valid" && String(p.expires_at) >= today && String(p.expires_at) <= new Date(now + 30 * DAY).toISOString().slice(0, 10)).map((p) => p.listing_id));
    const R = listings.map((l) => {
      const unit: any = unitBy.get(l.get("unitId")), b: any = unit ? bBy.get(unit.get("buildingId")) : null, id = l.get("id") as string;
      const q = listingQuality(l.get({ plain: true }), photos.get(id) ?? 0, plans.has(id), validPermit.has(id));
      return { id, ref: l.get("reference") ?? "", title: l.get("title") ?? "(untitled)", status: l.get("status") as string, purpose: l.get("purpose") as string, price: l.get("price") ? Number(l.get("price")) : null, type: unit?.get("type") as string | undefined, community: b?.get("community") as string | undefined, views: Number(l.get("viewCount") ?? 0), enquiries: Number(l.get("enquiryCount") ?? 0),
        published: l.get("publishedAt") ? new Date(l.get("publishedAt")).getTime() : null, refreshed: l.get("lastRefreshedAt") ? new Date(l.get("lastRefreshedAt")).getTime() : null, expiresOn: l.get("expiresOn") as string | null, featured: !!l.get("featured"), web: !!l.get("shareEnabled"), exclusive: l.get("exclusivity") !== "none", photos: photos.get(id) ?? 0, hasPermit: validPermit.has(id), permitExpiring: expiringPermit.has(id), quality: q.score };
    });
    const live = R.filter((r) => r.status === "published");
    const brief = (r: (typeof R)[number], why: string) => ({ id: r.id, ref: r.ref, title: r.title, why });
    const ageDays = (r: (typeof R)[number]) => Math.floor((now - (r.published ?? now)) / DAY);
    const totalViews = R.reduce((a, r) => a + r.views, 0), totalEnq = R.reduce((a, r) => a + r.enquiries, 0);
    return {
      generatedAt: new Date(now).toISOString(),
      totals: { all: R.length, published: live.length, draft: R.filter((r) => r.status === "draft").length, unpublished: R.filter((r) => r.status === "unpublished").length, onWebsite: live.filter((r) => r.web).length, featured: live.filter((r) => r.featured).length, exclusive: R.filter((r) => r.exclusive).length, views: totalViews, enquiries: totalEnq, enquiryRate: totalViews ? totalEnq / totalViews : null, avgQuality: R.length ? Math.round(R.reduce((a, r) => a + r.quality, 0) / R.length) : null, avgDaysOnMarket: live.length ? Math.round(live.reduce((a, r) => a + ageDays(r), 0) / live.length) : null, liveValue: live.reduce((a, r) => a + (r.price ?? 0), 0) },
      byStatus: count(R, (r) => r.status), byPurpose: count(R, (r) => r.purpose), byType: count(R, (r) => r.type), byCommunity: count(R, (r) => r.community).slice(0, 8),
      priceBands: count(live.filter((r) => r.price), (r) => band(r.price!, [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000], k)),
      age: [["0-30 days", 0, 30], ["31-60 days", 31, 60], ["61-90 days", 61, 90], ["90+ days", 91, 99999]].map(([label, a, b]) => ({ label: label as string, value: live.filter((r) => ageDays(r) >= (a as number) && ageDays(r) <= (b as number)).length })),
      quality: [["A (85+)", 85, 101], ["B (65-84)", 65, 85], ["C (45-64)", 45, 65], ["D (under 45)", 0, 45]].map(([label, a, b]) => ({ label: label as string, value: R.filter((r) => r.quality >= (a as number) && r.quality < (b as number)).length })),
      attention: {
        noPhotos: R.filter((r) => r.photos === 0 && r.status !== "unpublished").slice(0, 8).map((r) => brief(r, "No photos")),
        noPermit: live.filter((r) => !r.hasPermit).slice(0, 8).map((r) => brief(r, "No valid permit")),
        permitExpiring: live.filter((r) => r.permitExpiring).slice(0, 8).map((r) => brief(r, "Permit expires within 30 days")),
        expiring: live.filter((r) => r.expiresOn && r.expiresOn <= new Date(now + 7 * DAY).toISOString().slice(0, 10)).slice(0, 8).map((r) => brief(r, `Expires ${r.expiresOn}`)),
        stale: live.filter((r) => (r.refreshed ?? r.published ?? now) < now - 30 * DAY).slice(0, 8).map((r) => brief(r, "Not refreshed for 30+ days")),
        lowQuality: live.filter((r) => r.quality < 45).slice(0, 8).map((r) => brief(r, `Quality ${r.quality}`)),
      },
      topViewed: [...R].sort((a, b) => b.views - a.views).filter((r) => r.views > 0).slice(0, 5).map((r) => ({ id: r.id, ref: r.ref, title: r.title, views: r.views, enquiries: r.enquiries })),
      topEnquired: [...R].sort((a, b) => b.enquiries - a.enquiries).filter((r) => r.enquiries > 0).slice(0, 5).map((r) => ({ id: r.id, ref: r.ref, title: r.title, views: r.views, enquiries: r.enquiries })),
    };
  });
}
