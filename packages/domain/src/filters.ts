import { Op, QueryTypes, Sequelize, WhereOptions, literal } from "sequelize";
import type { RequestContext } from "@reales/database";
import { CONTACT_SCOPE } from "./contacts";
import { LEAD_SCOPE } from "./leads";
import { LISTING_SCOPE } from "./listings";
import { normalizePhone } from "./normalize";
import { plain, scopeWhere } from "./scope";
import { withUow } from "./uow";

const DAY = 86_400_000;
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => "\\" + m).slice(0, 80)}%`;
const isoDay = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
const dubaiDayStart = (day: string) => new Date(`${day}T00:00:00+04:00`);

// ===================================================================== leads
export interface LeadFilters {
  q?: string; status?: "open" | "won" | "lost"; stageIds?: string[]; purpose?: string[]; sourceIds?: string[]; campaign?: string; assigned?: "me" | "unassigned" | string; hot?: boolean;
  projectId?: string; budgetMin?: number; budgetMax?: number; bedrooms?: number; createdFrom?: string; createdTo?: string; followUp?: "overdue" | "today" | "week" | "none";
  staleDays?: number; tags?: string[]; language?: string; financing?: string; timeline?: string; inPool?: boolean; minScore?: number; neverContacted?: boolean;
  sort?: "newest" | "oldest" | "followup" | "budget" | "score" | "stale"; limit?: number; offset?: number;
}

/**
 * Lead search behind the basic and advanced filters. Every condition is optional and combined with AND; text search matches the contact's name, company,
 * e-mail and phone (any format). Visibility is the same scope as the plain lead list, so a filter can never reveal a lead the person could not already open.
 */
export async function searchLeadsAdvanced(sq: Sequelize, ctx: RequestContext, f: LeadFilters) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE)];
    const now = new Date();
    if (f.status) and.push({ status: f.status });
    if (f.stageIds?.length) and.push({ stageId: { [Op.in]: f.stageIds } });
    if (f.purpose?.length) and.push({ purpose: { [Op.in]: f.purpose } });
    if (f.sourceIds?.length) and.push({ sourceId: { [Op.in]: f.sourceIds } });
    if (f.campaign?.trim()) and.push({ campaign: f.campaign.trim() });
    if (f.assigned === "me") and.push({ assignedUserId: ctx.userId });
    else if (f.assigned === "unassigned") and.push({ assignedUserId: null });
    else if (f.assigned && /^[0-9a-f-]{36}$/i.test(f.assigned)) and.push({ assignedUserId: f.assigned });
    if (f.hot) and.push({ isHot: true });
    if (f.projectId) and.push({ projectId: f.projectId });
    if (f.budgetMin !== undefined) and.push({ budgetMax: { [Op.gte]: f.budgetMin } });
    if (f.budgetMax !== undefined) and.push({ [Op.or]: [{ budgetMin: { [Op.lte]: f.budgetMax } }, { budgetMin: null }] });
    if (f.bedrooms !== undefined) and.push(f.bedrooms >= 5 ? { bedrooms: { [Op.gte]: 5 } } : { bedrooms: f.bedrooms });
    const from = isoDay(f.createdFrom), to = isoDay(f.createdTo);
    if (from) and.push({ createdAt: { [Op.gte]: dubaiDayStart(from) } });
    if (to) and.push({ createdAt: { [Op.lt]: new Date(dubaiDayStart(to).getTime() + DAY) } });
    if (f.followUp === "overdue") and.push({ status: "open", nextFollowUpAt: { [Op.lt]: now } });
    else if (f.followUp === "today") { const s = dubaiDayStart(new Date(now.getTime() + 4 * 3_600_000).toISOString().slice(0, 10)); and.push({ nextFollowUpAt: { [Op.gte]: s, [Op.lt]: new Date(s.getTime() + DAY) } }); }
    else if (f.followUp === "week") and.push({ nextFollowUpAt: { [Op.gte]: now, [Op.lt]: new Date(now.getTime() + 7 * DAY) } });
    else if (f.followUp === "none") and.push({ status: "open", nextFollowUpAt: null });
    if (f.staleDays !== undefined && f.staleDays > 0) and.push({ status: "open", [Op.or]: [{ lastContactedAt: { [Op.lt]: new Date(now.getTime() - f.staleDays * DAY) } }, { lastContactedAt: null, createdAt: { [Op.lt]: new Date(now.getTime() - f.staleDays * DAY) } }] });
    if (f.neverContacted) and.push({ status: "open", lastContactedAt: null, firstResponseAt: null });
    for (const t of (f.tags ?? []).slice(0, 5)) and.push(literal(`JSON_CONTAINS(tags, ${sq.escape(JSON.stringify(t.trim().slice(0, 40)))})`));
    if (f.language) and.push({ language: f.language });
    if (f.financing) and.push({ financing: f.financing });
    if (f.timeline) and.push({ purchaseTimeline: f.timeline });
    if (f.inPool === true) and.push({ poolId: { [Op.ne]: null }, assignedUserId: null });
    if (f.minScore !== undefined) and.push({ score: { [Op.gte]: f.minScore } });
    if (f.q?.trim()) {
      const q = f.q.trim(), lk = like(q), digits = q.replace(/[^\d]/g, "").replace(/^(00)?971/, "").replace(/^0/, "");
      const or: WhereOptions[] = [{ firstName: { [Op.like]: lk } }, { lastName: { [Op.like]: lk } }, { companyName: { [Op.like]: lk } }, { normalizedEmail: { [Op.like]: lk.toLowerCase() } }];
      if (digits.length >= 4) or.push({ phoneE164: { [Op.like]: `%${digits}%` } }, { phoneSecondary: { [Op.like]: `%${digits}%` } }, { whatsappE164: { [Op.like]: `%${digits}%` } });
      void normalizePhone; void CONTACT_SCOPE;
      const ids = ((await u.repo("Contact").findAll({ where: { [Op.or]: or }, attributes: ["id"], limit: 500, transaction: u.tx })) as any[]).map((c) => c.get("id") as string);
      and.push({ contactId: { [Op.in]: ids.length ? ids : ["-"] } });
    }
    const order: [string, string][] = f.sort === "oldest" ? [["createdAt", "ASC"]] : f.sort === "followup" ? [["nextFollowUpAt", "ASC"]] : f.sort === "budget" ? [["budgetMax", "DESC"]] : f.sort === "score" ? [["score", "DESC"]] : f.sort === "stale" ? [["lastContactedAt", "ASC"]] : [["createdAt", "DESC"]];
    const where = { [Op.and]: and };
    const [rows, total] = await Promise.all([
      u.repo("Lead").findAll({ where, order, limit: Math.min(f.limit ?? 25, 300), offset: f.offset ?? 0, transaction: u.tx }),
      u.repo("Lead").count({ where, transaction: u.tx }),
    ]);
    return { rows: rows.map(plain), total: Number(total) };
  });
}

// ===================================================================== listings
export interface ListingFilters {
  q?: string; status?: string; purpose?: string; types?: string[]; bedsMin?: number; bedsMax?: number; minPrice?: number; maxPrice?: number; community?: string; projectId?: string; agentId?: string | "me";
  featured?: boolean; exclusivity?: "exclusive" | "non_exclusive" | "none"; expiringInDays?: number; noPhotos?: boolean; permit?: "missing" | "expiring" | "valid"; onWebsite?: boolean; furnishing?: string;
  createdFrom?: string; createdTo?: string; staleDays?: number; hasEnquiries?: boolean; sort?: "newest" | "oldest" | "price_asc" | "price_desc" | "views" | "enquiries" | "expiry"; limit?: number; offset?: number;
}

export async function searchListingsAdvanced(sq: Sequelize, ctx: RequestContext, f: ListingFilters) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "listing.read", LISTING_SCOPE)];
    const now = new Date(), today = now.toISOString().slice(0, 10);
    if (f.status) and.push({ status: f.status });
    if (f.purpose) and.push({ purpose: f.purpose });
    if (f.minPrice !== undefined) and.push({ price: { [Op.gte]: f.minPrice } });
    if (f.maxPrice !== undefined) and.push({ price: { [Op.lte]: f.maxPrice } });
    if (f.projectId) and.push({ projectId: f.projectId });
    if (f.agentId) and.push({ agentUserId: f.agentId === "me" ? ctx.userId : f.agentId });
    if (f.featured) and.push({ featured: true });
    if (f.exclusivity) and.push({ exclusivity: f.exclusivity });
    if (f.furnishing) and.push({ furnishing: f.furnishing });
    if (f.onWebsite) and.push({ shareEnabled: true });
    if (f.hasEnquiries) and.push({ enquiryCount: { [Op.gt]: 0 } });
    if (f.expiringInDays !== undefined) and.push({ status: "published", expiresOn: { [Op.ne]: null, [Op.lte]: new Date(now.getTime() + f.expiringInDays * DAY).toISOString().slice(0, 10) } });
    if (f.staleDays !== undefined) and.push({ status: "published", [Op.or]: [{ lastRefreshedAt: { [Op.lt]: new Date(now.getTime() - f.staleDays * DAY) } }, { lastRefreshedAt: null, publishedAt: { [Op.lt]: new Date(now.getTime() - f.staleDays * DAY) } }] });
    if (f.noPhotos) and.push(literal("NOT EXISTS (SELECT 1 FROM listing_media m WHERE m.listing_id = Listing.id AND m.tenant_id = Listing.tenant_id AND m.kind = 'image')"));
    if (f.permit === "missing") and.push(literal("NOT EXISTS (SELECT 1 FROM listing_permits p WHERE p.listing_id = Listing.id AND p.tenant_id = Listing.tenant_id AND p.status = 'valid' AND p.expires_at >= CURDATE())"));
    if (f.permit === "valid") and.push(literal("EXISTS (SELECT 1 FROM listing_permits p WHERE p.listing_id = Listing.id AND p.tenant_id = Listing.tenant_id AND p.status = 'valid' AND p.expires_at >= CURDATE())"));
    if (f.permit === "expiring") and.push(literal(`EXISTS (SELECT 1 FROM listing_permits p WHERE p.listing_id = Listing.id AND p.tenant_id = Listing.tenant_id AND p.status = 'valid' AND p.expires_at BETWEEN ${sq.escape(today)} AND ${sq.escape(new Date(now.getTime() + 30 * DAY).toISOString().slice(0, 10))})`));
    const from = isoDay(f.createdFrom), to = isoDay(f.createdTo);
    if (from) and.push({ createdAt: { [Op.gte]: dubaiDayStart(from) } });
    if (to) and.push({ createdAt: { [Op.lt]: new Date(dubaiDayStart(to).getTime() + DAY) } });

    // conditions that live on the unit or its building
    const unitWhere: WhereOptions[] = [];
    if (f.types?.length) unitWhere.push({ type: { [Op.in]: f.types } });
    if (f.bedsMin !== undefined) unitWhere.push({ bedrooms: { [Op.gte]: f.bedsMin } });
    if (f.bedsMax !== undefined) unitWhere.push({ bedrooms: { [Op.lte]: f.bedsMax } });
    if (f.community?.trim()) {
      const bs = (await u.repo("Building").findAll({ where: { community: f.community.trim() }, attributes: ["id"], limit: 500, transaction: u.tx })) as any[];
      unitWhere.push({ buildingId: { [Op.in]: bs.length ? bs.map((b) => b.get("id")) : ["-"] } });
    }
    if (f.q?.trim()) {
      const lk = like(f.q.trim());
      const [us, bs] = await Promise.all([
        u.repo("Unit").findAll({ where: { unitNumber: { [Op.like]: lk } }, attributes: ["id"], limit: 300, transaction: u.tx }),
        u.repo("Building").findAll({ where: { [Op.or]: [{ name: { [Op.like]: lk } }, { community: { [Op.like]: lk } }] }, attributes: ["id"], limit: 200, transaction: u.tx }),
      ]);
      const byB = (bs as any[]).length ? ((await u.repo("Unit").findAll({ where: { buildingId: { [Op.in]: (bs as any[]).map((b) => b.get("id")) } }, attributes: ["id"], limit: 800, transaction: u.tx })) as any[]) : [];
      const ids = [...new Set([...(us as any[]), ...byB].map((x) => x.get("id") as string))];
      and.push({ [Op.or]: [{ title: { [Op.like]: lk } }, { reference: { [Op.like]: lk } }, { unitId: { [Op.in]: ids.length ? ids : ["-"] } }] });
    }
    if (unitWhere.length) {
      const us = (await u.repo("Unit").findAll({ where: { [Op.and]: unitWhere }, attributes: ["id"], limit: 5000, transaction: u.tx })) as any[];
      and.push({ unitId: { [Op.in]: us.length ? us.map((x) => x.get("id")) : ["-"] } });
    }
    const order: [string, string][] = f.sort === "oldest" ? [["createdAt", "ASC"]] : f.sort === "price_asc" ? [["price", "ASC"]] : f.sort === "price_desc" ? [["price", "DESC"]] : f.sort === "views" ? [["viewCount", "DESC"]] : f.sort === "enquiries" ? [["enquiryCount", "DESC"]] : f.sort === "expiry" ? [["expiresOn", "ASC"]] : [["createdAt", "DESC"]];
    const where = { [Op.and]: and };
    const [rows, total] = await Promise.all([
      u.repo("Listing").findAll({ where, order, limit: Math.min(f.limit ?? 25, 300), offset: f.offset ?? 0, transaction: u.tx }),
      u.repo("Listing").count({ where, transaction: u.tx }),
    ]);
    const unitRows = rows.length ? ((await u.repo("Unit").findAll({ where: { id: { [Op.in]: rows.map((r: any) => r.get("unitId")) } }, transaction: u.tx })) as any[]) : [];
    const buildingRows = unitRows.length ? ((await u.repo("Building").findAll({ where: { id: { [Op.in]: [...new Set(unitRows.map((x) => x.get("buildingId") as string))] } }, transaction: u.tx })) as any[]) : [];
    const photos: { listing_id: string; n: number }[] = rows.length ? await u.sq.query<{ listing_id: string; n: number }>("SELECT listing_id, COUNT(*) AS n FROM listing_media WHERE tenant_id=:t AND listing_id IN (:ids) AND kind='image' GROUP BY listing_id", { replacements: { t: ctx.tenantId, ids: rows.map((r: any) => r.get("id")) }, transaction: u.tx, type: QueryTypes.SELECT }) : [];
    const photoCount = new Map(photos.map((p) => [p.listing_id, Number(p.n)]));
    const uBy = new Map(unitRows.map((x) => [x.get("id"), x])), bBy = new Map(buildingRows.map((x) => [x.get("id"), x]));
    return {
      total: Number(total),
      rows: rows.map((r: any) => {
        const unit: any = uBy.get(r.get("unitId")), b: any = unit ? bBy.get(unit.get("buildingId")) : null;
        return { ...plain(r), photoCount: photoCount.get(r.get("id")) ?? 0, unit: unit ? { unitNumber: unit.get("unitNumber"), type: unit.get("type"), bedrooms: unit.get("bedrooms"), areaSqft: unit.get("areaSqft"), status: unit.get("status"), building: b?.get("name") ?? null, community: b?.get("community") ?? null } : null };
      }),
    };
  });
}

/**
 * The broad picture of lead status for the strip above the Leads list: how many open leads sit in each pipeline stage, how many were won or lost, and the
 * counts that need action (hot, follow-up overdue, unassigned, never contacted, waiting in a pool). Counts follow the caller's visibility.
 */
export async function leadStatusSummary(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
    const now = new Date(), c = (extra: WhereOptions) => u.repo("Lead").count({ where: { [Op.and]: [scope, extra] }, transaction: u.tx });
    const [stages, byStage, won, lost, hot, overdue, unassigned, never, pooled, today] = await Promise.all([
      u.repo("PipelineStage").findAll({ order: [["position", "ASC"]], transaction: u.tx }),
      u.repo("Lead").findAll({ where: { [Op.and]: [scope, { status: "open" }] }, attributes: ["stageId", [literal("COUNT(*)"), "n"]], group: ["stageId"], raw: true, transaction: u.tx }) as unknown as Promise<{ stageId: string; n: number | string }[]>,
      c({ status: "won" }), c({ status: "lost" }), c({ status: "open", isHot: true }), c({ status: "open", nextFollowUpAt: { [Op.ne]: null, [Op.lt]: now } }),
      c({ status: "open", assignedUserId: null, poolId: null }), c({ status: "open", lastContactedAt: null, firstResponseAt: null }), c({ status: "open", assignedUserId: null, poolId: { [Op.ne]: null } }),
      c({ createdAt: { [Op.gte]: new Date(`${new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10)}T00:00:00+04:00`) } }),
    ]);
    const counts = new Map(byStage.map((r) => [r.stageId, Number(r.n)]));
    const seen = new Set<string>();
    const list = (stages as any[]).filter((s) => s.get("kind") === "open").map((s) => ({ id: s.get("id") as string, name: s.get("name") as string, count: counts.get(s.get("id")) ?? 0 }))
      .filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
    return { stages: list, open: list.reduce((a, s) => a + s.count, 0), won, lost, hot, overdue, unassigned, neverContacted: never, inPool: pooled, today };
  });
}
