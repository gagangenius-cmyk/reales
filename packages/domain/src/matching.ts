import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { RequestContext } from "@reales/database";
import { hasPermission, ForbiddenError } from "@reales/rbac";
import { LEAD_SCOPE } from "./leads";
import { notifyInUow } from "./notifications";
import { plain, scopeWhere } from "./scope";
import { assertSweepAllowed, ConflictError, NotFoundError, Uow, withUow } from "./uow";

export interface MatchCriteria { purpose?: "sale" | "rent"; minPrice?: number; maxPrice?: number; bedrooms?: number; communities?: string[]; types?: string[] }
export interface Candidate { listingId: string; title: string; purpose: "sale" | "rent"; price: number; currency: string; bedrooms: number | null; type: string; community: string | null; unitNumber: string; areaSqft: number | null }
export interface MatchResult { score: number; reasons: string[] }

const BUDGET_SLACK = 1.1; // up to 10% above the stated maximum is shown, but scored lower

/** Pure and deterministic. Returns null when a hard requirement fails (purpose, type, or far above budget), otherwise a 0-100 score with reasons. */
export function scoreMatch(c: MatchCriteria, l: Candidate): MatchResult | null {
  const reasons: string[] = [];
  let score = 0;
  if (c.purpose && c.purpose !== l.purpose) return null;
  if (c.types?.length && !c.types.map((t) => t.toLowerCase()).includes(l.type.toLowerCase())) return null;

  // budget (40)
  const { minPrice, maxPrice } = c;
  if (maxPrice === undefined && minPrice === undefined) { score += 20; reasons.push("No budget stated"); }
  else if (maxPrice !== undefined && l.price > maxPrice * BUDGET_SLACK) return null;
  else if (maxPrice !== undefined && l.price > maxPrice) { score += 20; reasons.push("Slightly above budget (within 10%)"); }
  else if (minPrice !== undefined && l.price < minPrice * 0.8) { score += 15; reasons.push("Well below the stated minimum budget"); }
  else { score += 40; reasons.push("Within budget"); }

  // bedrooms (30)
  if (c.bedrooms === undefined || c.bedrooms === null) { score += 15; reasons.push("No bedroom preference"); }
  else if (l.bedrooms === c.bedrooms) { score += 30; reasons.push(`${l.bedrooms} bedrooms as requested`); }
  else if (l.bedrooms !== null && Math.abs(l.bedrooms - c.bedrooms) === 1) { score += 15; reasons.push(`${l.bedrooms} bedrooms (one off)`); }
  else reasons.push("Different number of bedrooms");

  // area (30)
  const wanted = (c.communities ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) { score += 15; reasons.push("No area preference"); }
  else if (l.community && wanted.some((w) => l.community!.toLowerCase().includes(w) || w.includes(l.community!.toLowerCase()))) { score += 30; reasons.push(`In ${l.community}`); }
  else reasons.push("Outside preferred areas");

  return { score, reasons };
}

export const leadCriteria = (lead: any): MatchCriteria => ({
  purpose: lead.get("purpose") === "rent" ? "rent" : "sale",
  minPrice: lead.get("budgetMin") != null ? Number(lead.get("budgetMin")) : undefined,
  maxPrice: lead.get("budgetMax") != null ? Number(lead.get("budgetMax")) : undefined,
  bedrooms: lead.get("bedrooms") ?? undefined,
  communities: Array.isArray(lead.get("preferredAreas")) ? lead.get("preferredAreas") : undefined,
});

async function publishedCandidates(u: Uow, o: { since?: Date } = {}): Promise<Candidate[]> {
  const rows = await u.sq.query<any>(
    `SELECT l.id listing_id, l.title, l.purpose, l.price, l.currency, un.bedrooms, un.type, un.unit_number, un.area_sqft, b.community
       FROM listings l JOIN units un ON un.id = l.unit_id AND un.tenant_id = l.tenant_id JOIN buildings b ON b.id = un.building_id AND b.tenant_id = un.tenant_id
      WHERE l.tenant_id=:t AND l.deleted_at IS NULL AND un.deleted_at IS NULL AND l.status='published' AND l.price IS NOT NULL ${o.since ? "AND l.published_at > :since" : ""} ORDER BY l.published_at DESC LIMIT 1000`,
    { replacements: { t: u.tenantId, since: o.since ? o.since.toISOString().replace("T", " ").replace("Z", "") : null }, transaction: u.tx, type: QueryTypes.SELECT },
  );
  return rows.map((r) => ({ listingId: r.listing_id, title: r.title, purpose: r.purpose, price: Number(r.price), currency: r.currency, bedrooms: r.bedrooms, type: r.type, community: r.community, unitNumber: r.unit_number, areaSqft: r.area_sqft ? Number(r.area_sqft) : null }));
}

export function rank(c: MatchCriteria, cands: Candidate[], min = 50, limit = 10) {
  return cands.map((l) => ({ l, m: scoreMatch(c, l) })).filter((x): x is { l: Candidate; m: MatchResult } => !!x.m && x.m.score >= min).sort((a, b) => b.m.score - a.m.score || a.l.price - b.l.price).slice(0, limit);
}

async function scopedLead(u: Uow, ctx: RequestContext, id: string, perm = "match.read") {
  const scope = await scopeWhere(u, ctx, perm, LEAD_SCOPE);
  const l: any = await u.repo("Lead").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!l) throw new NotFoundError("Lead");
  return l;
}

async function persist(u: Uow, leadId: string, ranked: ReturnType<typeof rank>) {
  for (const { l, m } of ranked) {
    const ex: any = await u.repo("PropertyMatch").findOne({ where: { leadId, listingId: l.listingId }, transaction: u.tx });
    if (!ex) await u.repo("PropertyMatch").create({ id: randomUUID(), leadId, listingId: l.listingId, score: m.score, reasons: m.reasons, status: "new" }, { transaction: u.tx });
    else if (ex.get("status") !== "dismissed" && ex.get("score") !== m.score) await u.repo("PropertyMatch").updateById(ex.get("id"), { score: m.score, reasons: m.reasons }, { transaction: u.tx });
  }
}

export async function matchesForLead(sq: Sequelize, ctx: RequestContext, leadId: string) {
  return withUow(sq, ctx, async (u) => {
    const lead = await scopedLead(u, ctx, leadId);
    const ranked = rank(leadCriteria(lead), await publishedCandidates(u));
    if (hasPermission(ctx, "match.manage")) await persist(u, leadId, ranked);
    const dismissed = new Set(((await u.repo("PropertyMatch").findAll({ where: { leadId, status: "dismissed" }, transaction: u.tx })) as any[]).map((m) => m.get("listingId")));
    const status = new Map(((await u.repo("PropertyMatch").findAll({ where: { leadId }, transaction: u.tx })) as any[]).map((m) => [m.get("listingId"), m.get("status")]));
    return ranked.filter((x) => !dismissed.has(x.l.listingId)).map((x) => ({ ...x.l, score: x.m.score, reasons: x.m.reasons, status: status.get(x.l.listingId) ?? "new" }));
  });
}

/** Reverse view: which of my visible open leads fit this listing? */
export async function matchesForListing(sq: Sequelize, ctx: RequestContext, listingId: string) {
  return withUow(sq, ctx, async (u) => {
    const cand = (await publishedCandidates(u)).find((c) => c.listingId === listingId);
    if (!cand) throw new NotFoundError("Published listing");
    const scope = await scopeWhere(u, ctx, "match.read", LEAD_SCOPE);
    const leads = (await u.repo("Lead").findAll({ where: { [Op.and]: [{ status: "open" }, scope] }, limit: 2000, transaction: u.tx })) as any[];
    const out = [];
    for (const l of leads) {
      const m = scoreMatch(leadCriteria(l), cand);
      if (m && m.score >= 50) out.push({ leadId: l.get("id"), contactId: l.get("contactId"), assignedUserId: l.get("assignedUserId"), score: m.score, reasons: m.reasons });
    }
    return { listing: cand, leads: out.sort((a, b) => b.score - a.score).slice(0, 25) };
  });
}

export async function setMatchStatus(sq: Sequelize, ctx: RequestContext, leadId: string, listingId: string, status: "shared" | "dismissed") {
  return withUow(sq, ctx, async (u) => {
    await scopedLead(u, ctx, leadId, "match.manage");
    const m: any = await u.repo("PropertyMatch").findOne({ where: { leadId, listingId }, transaction: u.tx });
    if (!m) throw new NotFoundError("Match");
    await u.repo("PropertyMatch").updateById(m.get("id"), { status }, { transaction: u.tx });
    return plain(await u.repo("PropertyMatch").findById(m.get("id"), { transaction: u.tx }));
  });
}

// ---------------------------------------------------------------- saved searches
const criteriaOf = (c: any): MatchCriteria => ({
  purpose: c.purpose, minPrice: c.minPrice, maxPrice: c.maxPrice, bedrooms: c.bedrooms, communities: c.communities, types: c.types,
});

export async function createSavedSearch(sq: Sequelize, ctx: RequestContext, i: { name: string; criteria: MatchCriteria; contactId?: string; leadId?: string; notify?: boolean }) {
  if (!hasPermission(ctx, "match.manage")) throw new ForbiddenError("Missing permission: match.manage");
  if (i.criteria.minPrice !== undefined && i.criteria.maxPrice !== undefined && i.criteria.minPrice > i.criteria.maxPrice) throw new ConflictError("Minimum price exceeds the maximum");
  return withUow(sq, ctx, async (u) => {
    if (i.contactId && !(await u.repo("Contact").findById(i.contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    if (i.leadId) await scopedLead(u, ctx, i.leadId, "match.manage");
    const s = await u.repo("SavedSearch").create({ id: randomUUID(), name: i.name, ownerUserId: ctx.userId, contactId: i.contactId ?? null, leadId: i.leadId ?? null, criteria: i.criteria, notify: i.notify ?? true, status: "active", lastRunAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "saved_search.created", entityType: "saved_search", entityId: (s as any).get("id") });
    return plain(s);
  });
}

export async function listSavedSearches(sq: Sequelize, ctx: RequestContext) {
  if (!hasPermission(ctx, "match.read")) throw new ForbiddenError("Missing permission: match.read");
  return withUow(sq, ctx, async (u) => {
    const mine = hasPermission(ctx, "match.manage") && ctx.grants.some((g) => g.permission === "match.manage" && g.scope !== "own_records") ? {} : { ownerUserId: ctx.userId };
    return (await u.repo("SavedSearch").findAll({ where: mine, order: [["createdAt", "DESC"]], transaction: u.tx })).map(plain);
  });
}

export async function runSavedSearch(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const s: any = await u.repo("SavedSearch").findById(id, { transaction: u.tx });
    if (!s || (s.get("ownerUserId") !== ctx.userId && !ctx.grants.some((g) => g.permission === "match.manage" && g.scope !== "own_records"))) throw new NotFoundError("Saved search");
    const ranked = rank(criteriaOf(s.get("criteria")), await publishedCandidates(u), 50, 25);
    return ranked.map((x) => ({ ...x.l, score: x.m.score, reasons: x.m.reasons }));
  });
}

export async function setSavedSearchStatus(sq: Sequelize, ctx: RequestContext, id: string, status: "active" | "paused") {
  if (!hasPermission(ctx, "match.manage")) throw new ForbiddenError("Missing permission: match.manage");
  return withUow(sq, ctx, async (u) => {
    const s: any = await u.repo("SavedSearch").findById(id, { transaction: u.tx });
    if (!s || s.get("ownerUserId") !== ctx.userId) throw new NotFoundError("Saved search");
    await u.repo("SavedSearch").updateById(id, { status }, { transaction: u.tx });
    return plain(await u.repo("SavedSearch").findById(id, { transaction: u.tx }));
  });
}

/**
 * Idempotent sweep. For assigned open leads: persist new strong matches (score >= 70) and tell the agent once per pair.
 * For active saved searches: alert the owner about listings published since the last run, once per listing.
 */
export async function matchSweep(sq: Sequelize, ctx: RequestContext, now = new Date()) {
  assertSweepAllowed(ctx, "match.manage");
  return withUow(sq, ctx, async (u) => {
    const out = { leadAlerts: 0, searchAlerts: 0 };
    const cands = await publishedCandidates(u);
    const leads = (await u.repo("Lead").findAll({ where: { status: "open", assignedUserId: { [Op.ne]: null } }, limit: 500, order: [["createdAt", "DESC"]], transaction: u.tx })) as any[];
    for (const l of leads) {
      const strong = rank(leadCriteria(l), cands, 70, 5);
      await persist(u, l.get("id"), strong);
      for (const { l: c, m } of strong) {
        const pm: any = await u.repo("PropertyMatch").findOne({ where: { leadId: l.get("id"), listingId: c.listingId }, transaction: u.tx });
        if (pm?.get("status") === "dismissed") continue;
        if (await notifyInUow(u, { userId: l.get("assignedUserId"), kind: "match.new", title: `New match (${m.score}%): ${c.title}`, body: m.reasons.join(", "), entityType: "lead", entityId: l.get("id"), dedupeKey: `match:${l.get("id")}:${c.listingId}` })) out.leadAlerts++;
      }
    }
    const searches = (await u.repo("SavedSearch").findAll({ where: { status: "active", notify: true }, transaction: u.tx })) as any[];
    for (const s of searches) {
      const since = s.get("lastRunAt") ? new Date(s.get("lastRunAt")) : now;
      const fresh = (await publishedCandidates(u, { since }));
      for (const { l: c } of rank(criteriaOf(s.get("criteria")), fresh, 50, 10)) {
        if (await notifyInUow(u, { userId: s.get("ownerUserId"), kind: "search.new_listing", title: `Saved search "${s.get("name")}": ${c.title}`, body: `${c.currency} ${c.price.toLocaleString("en-US")}`, entityType: "listing", entityId: c.listingId, dedupeKey: `search:${s.get("id")}:${c.listingId}` })) out.searchAlerts++;
      }
      await u.repo("SavedSearch").updateById(s.get("id"), { lastRunAt: now }, { transaction: u.tx });
    }
    return out;
  });
}
