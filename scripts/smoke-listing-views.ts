import "dotenv/config";
import { QueryTypes } from "sequelize";
import { PERMISSIONS } from "../packages/rbac/src";
import { closeSequelize, getSequelize, type RequestContext } from "../packages/database/src";
import { leadsOverview, listingsOverview, searchLeadsAdvanced, searchListingsAdvanced } from "../packages/domain/src";

/** Read-only check that the overview and advanced filter queries run against the real schema. Prints counts only. */
async function main() {
  const sq = getSequelize();
  const [t] = await sq.query<{ id: string }>("SELECT id FROM tenants LIMIT 1", { type: QueryTypes.SELECT });
  const ctx: RequestContext = { tenantId: t!.id, userId: "00000000-0000-0000-0000-000000000000", sessionId: "smoke", correlationId: "smoke", grants: (Object.keys(PERMISSIONS) as string[]).map((permission) => ({ permission, scope: "tenant" as const })), membership: { businessUnitIds: [], branchIds: [], projectIds: [], portfolioIds: [] }, stepUpValid: false };
  const lo = await leadsOverview(sq, ctx);
  console.log("leads overview", lo.totals.all, "open", lo.totals.open, "funnel", lo.funnel.length);
  const io = await listingsOverview(sq, ctx);
  console.log("listings overview", io.totals.all, "published", io.totals.published);
  for (const sort of ["newest", "oldest", "followup", "budget", "score", "stale"] as const) console.log("leads sort", sort, (await searchLeadsAdvanced(sq, ctx, { sort, limit: 5 })).total);
  console.log("leads all filters", (await searchLeadsAdvanced(sq, ctx, { q: "ahmed", status: "open", hot: true, budgetMin: 1, budgetMax: 99999999, followUp: "overdue", staleDays: 3, tags: ["x"], language: "en", financing: "cash", timeline: "now", inPool: false, minScore: 1, neverContacted: false, bedrooms: 2, createdFrom: "2020-01-01", createdTo: "2030-01-01", assigned: "me", campaign: "x" })).total);
  for (const sort of ["newest", "oldest", "price_asc", "price_desc", "views", "enquiries", "expiry"] as const) console.log("listings sort", sort, (await searchListingsAdvanced(sq, ctx, { sort, limit: 5 })).total);
  console.log("listings all filters", (await searchListingsAdvanced(sq, ctx, { q: "marina", status: "published", purpose: "sale", types: ["apartment"], bedsMin: 1, bedsMax: 4, minPrice: 1, maxPrice: 99999999, community: "Marina", featured: true, exclusivity: "exclusive", expiringInDays: 30, noPhotos: true, permit: "missing", onWebsite: true, furnishing: "furnished", createdFrom: "2020-01-01", createdTo: "2030-01-01", staleDays: 5, hasEnquiries: true })).total);
  for (const permit of ["missing", "expiring", "valid"] as const) console.log("permit", permit, (await searchListingsAdvanced(sq, ctx, { permit })).total);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => closeSequelize());
