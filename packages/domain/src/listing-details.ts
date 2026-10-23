import { randomBytes, randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, systemContext, type RequestContext } from "@reales/database";
import { authorize, ForbiddenError, hasPermission } from "@reales/rbac";
import { cleanAmenities } from "./amenities";
import { getSetting } from "./config";
import { nextCounter } from "./finance";
import { ingestLead } from "./leads";
import { LISTING_SCOPE, evaluateListing, publishListing, unpublishListingInUow } from "./listings";
import { notifyInUow } from "./notifications";
import { notifyUser } from "./notify";
import { plain, scopeWhere } from "./scope";
import { getStorage, scanUpload, storageKeyFor, validateUpload } from "./storage";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

const ref = (l: any) => ({ ownerUserId: l.get("agentUserId"), branchId: l.get("branchId"), projectId: l.get("projectId") });
const MAX_PHOTOS = 40;
const isImage = (m: string) => m.startsWith("image/");
const httpUrl = (v: string, label: string) => {
  try { const u = new URL(v); if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(); return u.toString().slice(0, 300); } catch { throw new ConflictError(`${label} must be a full http(s) link`); }
};

async function scoped(u: Uow, ctx: RequestContext, id: string) {
  const scope = await scopeWhere(u, ctx, "listing.read", LISTING_SCOPE);
  const l: any = await u.repo("Listing").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!l) throw new NotFoundError("Listing");
  return l;
}

// ------------------------------------------------------------------ quality score (pure)
export interface QualityTip { points: number; max: number; tip: string }
export interface ListingQuality { score: number; grade: "A" | "B" | "C" | "D"; tips: QualityTip[] }

/** How complete and competitive a listing is. Pure so it can be tested and shown anywhere. Tips list what is still missing, biggest gain first. */
export function listingQuality(l: Record<string, any>, photos: number, hasFloorplan: boolean, validPermit: boolean): ListingQuality {
  const features = Array.isArray(l.features) ? l.features.length : 0;
  const parts: QualityTip[] = [
    { max: 10, points: Math.min(10, Math.round(((String(l.title ?? "").trim().length) / 40) * 10)), tip: "Write a descriptive title of about 40 characters" },
    { max: 15, points: Math.min(15, Math.round(((String(l.description ?? "").trim().length) / 400) * 15)), tip: "Write a description of at least 400 characters" },
    { max: 25, points: Math.min(25, Math.round((photos / 10) * 25)), tip: `Add photos (${photos} of 10 recommended)` },
    { max: 5, points: hasFloorplan ? 5 : 0, tip: "Upload a floor plan" },
    { max: 10, points: l.price ? 10 : 0, tip: "Set a price" },
    { max: 10, points: Math.min(10, features * 2), tip: `Tick amenities and features (${features} of 5)` },
    { max: 15, points: validPermit ? 15 : 0, tip: "Add a verified advertising permit" },
    { max: 5, points: l.latitude != null && l.longitude != null ? 5 : 0, tip: "Add map coordinates" },
    { max: 5, points: l.titleAr && l.descriptionAr ? 5 : 0, tip: "Add the Arabic title and description" },
  ];
  const score = parts.reduce((a, p) => a + p.points, 0);
  return { score, grade: score >= 85 ? "A" : score >= 65 ? "B" : score >= 45 ? "C" : "D", tips: parts.filter((p) => p.points < p.max).sort((a, b) => b.max - b.points - (a.max - a.points)) };
}

// ------------------------------------------------------------------ detail
async function ensureReference(u: Uow, ctx: RequestContext, l: any) {
  if (l.get("reference")) return l.get("reference") as string;
  const n = await nextCounter(u, ctx.tenantId, "listing");
  const reference = `RLS-${String(n).padStart(6, "0")}`;
  await u.repo("Listing").updateById(l.get("id"), { reference }, { transaction: u.tx });
  return reference;
}

/** Everything the listing screen needs in one call: the listing, its unit and building, media, permits, price history, portal state, enquiries, viewings, matches and quality. */
export async function getListingDetail(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    const reference = await ensureReference(u, ctx, l);
    const [unit, media, permits, prices, pubs, enquiries, viewings, agent] = await Promise.all([
      u.repo("Unit").findById(l.get("unitId"), { transaction: u.tx }),
      u.repo("ListingMedia").findAll({ where: { listingId: id }, order: [["position", "ASC"]], transaction: u.tx }),
      u.repo("ListingPermit").findAll({ where: { listingId: id }, order: [["expiresAt", "DESC"]], transaction: u.tx }),
      u.repo("ListingPrice").findAll({ where: { listingId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
      u.repo("PortalPublication").findAll({ where: { listingId: id }, order: [["createdAt", "DESC"]], limit: 30, attributes: { exclude: ["payload"] }, transaction: u.tx }),
      u.repo("ListingEnquiry").findAll({ where: { listingId: id }, order: [["createdAt", "DESC"]], limit: 30, transaction: u.tx }),
      hasPermission(ctx, "viewing.read") ? u.repo("Viewing").findAll({ where: { listingId: id }, order: [["scheduledAt", "DESC"]], limit: 20, transaction: u.tx }) : Promise.resolve([]),
      l.get("agentUserId") ? u.repo("User").findById(l.get("agentUserId"), { transaction: u.tx }) : Promise.resolve(null),
    ]);
    const building: any = unit ? await u.repo("Building").findById((unit as any).get("buildingId"), { transaction: u.tx }) : null;
    const locRow: any = building?.get("locationId") ? await u.repo("Location").findById(building.get("locationId"), { transaction: u.tx }) : null;
    const contacts = (enquiries as any[]).length ? ((await u.repo("Contact").findAll({ where: { id: { [Op.in]: (enquiries as any[]).map((e) => e.get("contactId")).filter(Boolean).concat(["-"]) } }, transaction: u.tx })) as any[]) : [];
    const name = new Map(contacts.map((c) => [c.get("id"), [c.get("firstName"), c.get("lastName")].filter(Boolean).join(" ") || c.get("email") || "Contact"]));
    const mediaRows = (media as any[]).map(plain);
    const quality = listingQuality({ ...plain(l), reference }, mediaRows.filter((m: any) => m.kind === "image").length, mediaRows.some((m: any) => m.kind === "floorplan"), (permits as any[]).some((p) => p.get("status") === "valid"));
    const evaluation = await evaluateListing(u, l);
    const days = Math.floor((Date.now() - new Date(l.get("publishedAt") ?? l.get("createdAt")).getTime()) / 86_400_000);
    return {
      ...plain(l), reference, unit: unit ? plain(unit) : null, building: building ? { ...plain(building), locationLat: locRow?.get("latitude") ?? null, locationLng: locRow?.get("longitude") ?? null } : null, agentEmail: (agent as any)?.get("email") ?? null,
      media: mediaRows, permits: (permits as any[]).map(plain), priceHistory: (prices as any[]).map(plain), publications: (pubs as any[]).map(plain),
      enquiries: (enquiries as any[]).map((e) => ({ ...plain(e), contactName: name.get(e.get("contactId")) ?? "Contact" })), viewings: (viewings as any[]).map(plain),
      quality, evaluation, daysOnMarket: days,
    };
  });
}

// ------------------------------------------------------------------ editing
export interface DetailsPatch {
  title?: string | null; description?: string | null; price?: number | null; features?: string[]; furnishing?: "unfurnished" | "semi_furnished" | "furnished" | null; parkingSpaces?: number | null;
  rentFrequency?: "yearly" | "quarterly" | "monthly" | null; cheques?: number | null; securityDeposit?: number | null; serviceCharge?: number | null; videoUrl?: string | null; virtualTourUrl?: string | null;
  titleAr?: string | null; descriptionAr?: string | null; exclusivity?: "none" | "exclusive" | "non_exclusive"; agreementStartsOn?: string | null; agreementExpiresOn?: string | null;
  ownerPrice?: number | null; commissionPct?: number | null; featured?: boolean; completionStatus?: "ready" | "off_plan" | null; ownership?: "freehold" | "leasehold" | "usufruct" | "musataha" | null; yearBuilt?: number | null; availableFrom?: string | null; utilitiesIncluded?: boolean | null; expiresOn?: string | null; latitude?: number | null; longitude?: number | null;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown, label: string, min = 0, max = 1e12) => { if (v === null || v === undefined) return null; const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new ConflictError(`${label} is out of range`); return n; };

/** Edit marketing, terms and lifecycle fields. Price changes are written to the price history; every changed field is audited with its old value. */
export async function updateListingDetails(sq: Sequelize, ctx: RequestContext, id: string, p: DetailsPatch) {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    const patch: Record<string, unknown> = {};
    const set = (k: string, v: unknown) => { patch[k] = v; };
    if (p.title !== undefined) set("title", p.title?.trim().slice(0, 255) || null);
    if (p.description !== undefined) set("description", p.description?.trim().slice(0, 10000) || null);
    if (p.titleAr !== undefined) set("titleAr", p.titleAr?.trim().slice(0, 255) || null);
    if (p.descriptionAr !== undefined) set("descriptionAr", p.descriptionAr?.trim().slice(0, 10000) || null);
    if (p.price !== undefined) { const n = num(p.price, "Price", 0.01); set("price", n); }
    if (p.ownerPrice !== undefined) set("ownerPrice", num(p.ownerPrice, "Owner price", 0.01));
    if (p.securityDeposit !== undefined) set("securityDeposit", num(p.securityDeposit, "Security deposit"));
    if (p.serviceCharge !== undefined) set("serviceCharge", num(p.serviceCharge, "Service charge"));
    if (p.commissionPct !== undefined) set("commissionPct", num(p.commissionPct, "Commission", 0, 100));
    if (p.parkingSpaces !== undefined) set("parkingSpaces", p.parkingSpaces === null ? null : Math.round(num(p.parkingSpaces, "Parking spaces", 0, 50)!));
    if (p.cheques !== undefined) set("cheques", p.cheques === null ? null : Math.round(num(p.cheques, "Cheques", 1, 12)!));
    if (p.latitude !== undefined || p.longitude !== undefined) {
      const lat = p.latitude === undefined ? l.get("latitude") : num(p.latitude, "Latitude", -90, 90), lng = p.longitude === undefined ? l.get("longitude") : num(p.longitude, "Longitude", -180, 180);
      if ((lat == null) !== (lng == null)) throw new ConflictError("Give both latitude and longitude, or neither");
      set("latitude", lat); set("longitude", lng);
    }
    if (p.completionStatus !== undefined) { if (p.completionStatus && !["ready", "off_plan"].includes(p.completionStatus)) throw new ConflictError("Unknown completion status"); set("completionStatus", p.completionStatus); }
    if (p.ownership !== undefined) { if (p.ownership && !["freehold", "leasehold", "usufruct", "musataha"].includes(p.ownership)) throw new ConflictError("Unknown ownership type"); set("ownership", p.ownership); }
    if (p.yearBuilt !== undefined) set("yearBuilt", p.yearBuilt === null ? null : Math.round(num(p.yearBuilt, "Year built", 1900, 2100)!));
    if (p.availableFrom !== undefined) { if (p.availableFrom !== null && !DATE.test(p.availableFrom)) throw new ConflictError("Dates must look like 2026-12-31"); set("availableFrom", p.availableFrom); }
    if (p.utilitiesIncluded !== undefined) set("utilitiesIncluded", p.utilitiesIncluded);
    if (p.features !== undefined) set("features", cleanAmenities(p.features));
    if (p.furnishing !== undefined) { if (p.furnishing && !["unfurnished", "semi_furnished", "furnished"].includes(p.furnishing)) throw new ConflictError("Unknown furnishing"); set("furnishing", p.furnishing); }
    if (p.rentFrequency !== undefined) { if (p.rentFrequency && !["yearly", "quarterly", "monthly"].includes(p.rentFrequency)) throw new ConflictError("Unknown rent frequency"); set("rentFrequency", p.rentFrequency); }
    if (p.videoUrl !== undefined) set("videoUrl", p.videoUrl ? httpUrl(p.videoUrl, "Video link") : null);
    if (p.virtualTourUrl !== undefined) set("virtualTourUrl", p.virtualTourUrl ? httpUrl(p.virtualTourUrl, "Virtual tour link") : null);
    if (p.exclusivity !== undefined) { if (!["none", "exclusive", "non_exclusive"].includes(p.exclusivity)) throw new ConflictError("Unknown exclusivity"); set("exclusivity", p.exclusivity); }
    for (const [k, col] of [["agreementStartsOn", "agreementStartsOn"], ["agreementExpiresOn", "agreementExpiresOn"], ["expiresOn", "expiresOn"]] as const) {
      const v = p[k]; if (v === undefined) continue;
      if (v !== null && !DATE.test(v)) throw new ConflictError("Dates must look like 2026-12-31");
      set(col, v);
    }
    const s = (patch.agreementStartsOn ?? l.get("agreementStartsOn")) as string | null, e = (patch.agreementExpiresOn ?? l.get("agreementExpiresOn")) as string | null;
    if (s && e && e < s) throw new ConflictError("The agreement cannot end before it starts");
    if ((patch.exclusivity ?? l.get("exclusivity")) !== "none" && !(e ?? l.get("agreementExpiresOn"))) throw new ConflictError("An exclusive or non-exclusive agreement needs an end date");
    if (p.featured !== undefined) set("featured", !!p.featured);
    if (!Object.keys(patch).length) return plain(l);
    const changed = Object.keys(patch).filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(l.get(k)));
    if (!changed.length) return plain(l);
    await u.repo("Listing").updateById(id, patch, { transaction: u.tx });
    if (patch.price != null && Number(patch.price) !== Number(l.get("price"))) await u.repo("ListingPrice").create({ id: randomUUID(), listingId: id, price: patch.price, currency: l.get("currency"), changedBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.audit({ action: "listing.details_updated", entityType: "listing", entityId: id, before: Object.fromEntries(changed.map((k) => [k, l.get(k)])), after: Object.fromEntries(changed.map((k) => [k, patch[k]])) });
    await u.emit({ type: "listing.updated", aggregateType: "listing", aggregateId: id, projectId: l.get("projectId"), payload: { fields: changed } });
    return plain(await u.repo("Listing").findById(id, { transaction: u.tx }));
  });
}

// ------------------------------------------------------------------ media
export async function uploadListingMedia(sq: Sequelize, ctx: RequestContext, id: string, file: { filename: string; mime?: string; bytes: Buffer }, o: { kind?: "image" | "floorplan"; caption?: string } = {}) {
  const v = validateUpload(file);
  if (!isImage(v.mime)) throw new ConflictError("Listing media must be a JPEG, PNG or WEBP image");
  await scanUpload(v);
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    const existing = (await u.repo("ListingMedia").findAll({ where: { listingId: id }, transaction: u.tx })) as any[];
    const key = storageKeyFor(ctx.tenantId, v.hash);
    if (existing.some((m) => m.get("storageKey") === key)) throw new ConflictError("This photo is already on the listing");
    if (existing.filter((m) => m.get("kind") !== "video").length >= MAX_PHOTOS) throw new ConflictError(`A listing can have at most ${MAX_PHOTOS} photos`);
    await getStorage().put(key, v.bytes);
    const mid = randomUUID();
    await u.repo("ListingMedia").create({ id: mid, listingId: id, kind: o.kind ?? "image", storageKey: key, position: existing.length, caption: o.caption?.trim().slice(0, 200) || null, fileName: v.filename, mime: v.mime, sizeBytes: v.bytes.length }, { transaction: u.tx });
    if (!l.get("coverMediaId") && (o.kind ?? "image") === "image") await u.repo("Listing").updateById(id, { coverMediaId: mid }, { transaction: u.tx });
    await u.audit({ action: "listing.media_added", entityType: "listing", entityId: id, after: { file: v.filename, kind: o.kind ?? "image", bytes: v.bytes.length } });
    return plain(await u.repo("ListingMedia").findById(mid, { transaction: u.tx }));
  });
}

export async function reorderListingMedia(sq: Sequelize, ctx: RequestContext, id: string, orderedIds: string[]) {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    const rows = (await u.repo("ListingMedia").findAll({ where: { listingId: id }, transaction: u.tx })) as any[];
    if (orderedIds.length !== rows.length || !rows.every((r) => orderedIds.includes(r.get("id")))) throw new ConflictError("Send every photo of the listing exactly once");
    for (const [i, mid] of orderedIds.entries()) await u.repo("ListingMedia").updateById(mid, { position: i }, { transaction: u.tx });
  });
}

export async function updateListingMedia(sq: Sequelize, ctx: RequestContext, id: string, mediaId: string, o: { caption?: string | null; cover?: boolean }) {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    const m: any = await u.repo("ListingMedia").findOne({ where: { id: mediaId, listingId: id }, transaction: u.tx });
    if (!m) throw new NotFoundError("Photo");
    if (o.caption !== undefined) await u.repo("ListingMedia").updateById(mediaId, { caption: o.caption?.trim().slice(0, 200) || null }, { transaction: u.tx });
    if (o.cover) { if (m.get("kind") !== "image") throw new ConflictError("Only a photo can be the cover"); await u.repo("Listing").updateById(id, { coverMediaId: mediaId }, { transaction: u.tx }); }
  });
}

export async function deleteListingMedia(sq: Sequelize, ctx: RequestContext, id: string, mediaId: string) {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    const m: any = await u.repo("ListingMedia").findOne({ where: { id: mediaId, listingId: id }, transaction: u.tx });
    if (!m) throw new NotFoundError("Photo");
    await u.repo("ListingMedia").deleteById(mediaId, { transaction: u.tx }); // the stored bytes are content-addressed and may be shared, so they stay
    if (l.get("coverMediaId") === mediaId) {
      const next: any = await u.repo("ListingMedia").findOne({ where: { listingId: id, kind: "image" }, order: [["position", "ASC"]], transaction: u.tx });
      await u.repo("Listing").updateById(id, { coverMediaId: next?.get("id") ?? null }, { transaction: u.tx });
    }
    await u.audit({ action: "listing.media_removed", entityType: "listing", entityId: id, after: { file: m.get("fileName") } });
  });
}

/** Bytes of one photo for a signed-in user who can see the listing. */
export async function readListingMedia(sq: Sequelize, ctx: RequestContext, id: string, mediaId: string) {
  return withUow(sq, ctx, async (u) => {
    await scoped(u, ctx, id);
    const m: any = await u.repo("ListingMedia").findOne({ where: { id: mediaId, listingId: id }, transaction: u.tx });
    if (!m || !m.get("mime")) throw new NotFoundError("Photo");
    return { bytes: await getStorage().get(m.get("storageKey")), mime: m.get("mime") as string, filename: (m.get("fileName") as string | null) ?? "photo" };
  });
}

// ------------------------------------------------------------------ public page
/** Turn the public page on or off, or issue a new link (the old one stops working). */
export async function setListingShare(sq: Sequelize, ctx: RequestContext, id: string, o: { enabled?: boolean; regenerate?: boolean }) {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.publish", ref(l));
    const patch: Record<string, unknown> = {};
    if (o.enabled !== undefined) patch.shareEnabled = o.enabled;
    if (o.regenerate || (o.enabled && !l.get("shareToken"))) patch.shareToken = randomBytes(24).toString("base64url");
    if (!Object.keys(patch).length) return { shareEnabled: !!l.get("shareEnabled"), shareToken: l.get("shareToken") as string | null };
    await u.repo("Listing").updateById(id, patch, { transaction: u.tx });
    await u.audit({ action: o.regenerate ? "listing.share_link_regenerated" : o.enabled ? "listing.share_enabled" : "listing.share_disabled", entityType: "listing", entityId: id });
    const fresh: any = await u.repo("Listing").findById(id, { transaction: u.tx });
    return { shareEnabled: !!fresh.get("shareEnabled"), shareToken: fresh.get("shareToken") as string | null };
  });
}

export interface PublicListing {
  token: string; reference: string; title: string; description: string | null; titleAr: string | null; descriptionAr: string | null; purpose: string; price: number | null; currency: string; rentFrequency: string | null;
  subCommunity?: string | null; plotAreaSqft?: number | null; floor?: number | null; completionStatus?: string | null; ownership?: string | null; yearBuilt?: number | null; availableFrom?: string | null; utilitiesIncluded?: boolean | null; exactLocation?: boolean;
  bedrooms: number | null; bathrooms: number | null; areaSqft: number | null; type: string | null; view: string | null; building: string | null; community: string | null; city: string | null;
  furnishing: string | null; parkingSpaces: number | null; features: string[]; videoUrl: string | null; virtualTourUrl: string | null; latitude: number | null; longitude: number | null;
  photos: { id: string; caption: string | null; kind: string }[]; cover: string | null; agency: string | null; permitNo: string | null;
}

/** What a stranger may see: only a published listing whose public page is on. No owner, price instructions, commission, agent e-mail or internal notes. Counts a view. */
export async function getPublicListing(sq: Sequelize, token: string, countView = true): Promise<PublicListing | null> {
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(token)) return null;
  const [row] = await sq.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM listings WHERE share_token=:t AND deleted_at IS NULL AND share_enabled=1 AND status='published'", { replacements: { t: token }, type: QueryTypes.SELECT });
  if (!row) return null;
  const ctx = systemContext(row.tenant_id, `corr_public_${randomUUID()}`);
  return withUow(sq, ctx, async (u) => {
    const l: any = await u.repo("Listing").findById(row.id, { transaction: u.tx });
    const unit: any = await u.repo("Unit").findById(l.get("unitId"), { transaction: u.tx });
    const b: any = unit ? await u.repo("Building").findById(unit.get("buildingId"), { transaction: u.tx }) : null;
    const media = (await u.repo("ListingMedia").findAll({ where: { listingId: row.id }, order: [["position", "ASC"]], transaction: u.tx })) as any[];
    const permit: any = await u.repo("ListingPermit").findOne({ where: { listingId: row.id, status: "valid" }, order: [["expiresAt", "DESC"]], transaction: u.tx });
    const [tenant] = await u.sq.query<{ name: string }>("SELECT name FROM tenants WHERE id=:t", { replacements: { t: row.tenant_id }, transaction: u.tx, type: QueryTypes.SELECT });
    if (countView) await u.sq.query("UPDATE listings SET view_count = view_count + 1 WHERE id=:id AND tenant_id=:t", { replacements: { id: row.id, t: row.tenant_id }, transaction: u.tx });
    const n = (v: unknown) => (v == null ? null : Number(v));
    const loc: any = b?.get("locationId") ? await u.repo("Location").findById(b.get("locationId"), { transaction: u.tx }) : null;
    const exact = l.get("latitude") != null || b?.get("latitude") != null;
    return {
      subCommunity: b?.get("subCommunity") ?? null, plotAreaSqft: n(unit?.get("plotAreaSqft")), floor: unit?.get("floor") ?? null, completionStatus: l.get("completionStatus") ?? null, ownership: l.get("ownership") ?? null, yearBuilt: l.get("yearBuilt") ?? null, availableFrom: l.get("availableFrom") ? String(l.get("availableFrom")).slice(0, 10) : null, utilitiesIncluded: l.get("utilitiesIncluded") ?? null, exactLocation: exact,
      token, reference: l.get("reference") ?? "", title: l.get("title") ?? "Property for " + l.get("purpose"), description: l.get("description"), titleAr: l.get("titleAr"), descriptionAr: l.get("descriptionAr"), purpose: l.get("purpose"),
      price: n(l.get("price")), currency: l.get("currency"), rentFrequency: l.get("rentFrequency"), bedrooms: unit?.get("bedrooms") ?? null, bathrooms: unit?.get("bathrooms") ?? null, areaSqft: n(unit?.get("areaSqft")), type: unit?.get("type") ?? null,
      view: unit?.get("view") ?? null, building: b?.get("name") ?? null, community: b?.get("community") ?? null, city: b?.get("city") ?? null, furnishing: l.get("furnishing"), parkingSpaces: l.get("parkingSpaces"),
      features: Array.isArray(l.get("features")) ? l.get("features") : [], videoUrl: l.get("videoUrl"), virtualTourUrl: l.get("virtualTourUrl"), latitude: n(l.get("latitude") ?? b?.get("latitude") ?? loc?.get("latitude")), longitude: n(l.get("longitude") ?? b?.get("longitude") ?? loc?.get("longitude")),
      photos: media.filter((m) => m.get("mime")).map((m) => ({ id: m.get("id"), caption: m.get("caption"), kind: m.get("kind") })), cover: l.get("coverMediaId"), agency: tenant?.name ?? null, permitNo: permit?.get("permitNo") ?? null,
    };
  });
}

export async function readPublicMedia(sq: Sequelize, token: string, mediaId: string) {
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(token)) throw new NotFoundError("Photo");
  const [row] = await sq.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM listings WHERE share_token=:t AND deleted_at IS NULL AND share_enabled=1 AND status='published'", { replacements: { t: token }, type: QueryTypes.SELECT });
  if (!row) throw new NotFoundError("Photo");
  const m = await withUow(sq, systemContext(row.tenant_id, `corr_public_${randomUUID()}`), (u) => u.repo("ListingMedia").findOne({ where: { id: mediaId, listingId: row.id }, transaction: u.tx })) as any;
  if (!m?.get("mime")) throw new NotFoundError("Photo");
  return { bytes: await getStorage().get(m.get("storageKey")), mime: m.get("mime") as string };
}

export interface EnquiryInput { name: string; phone?: string; email?: string; message?: string; website?: string }

/** A visitor's enquiry from the public page: creates (or updates) a lead assigned to the listing's agent, logs it against the listing and notifies the agent. */
export async function submitListingEnquiry(sq: Sequelize, token: string, i: EnquiryInput) {
  if (i.website?.trim()) return { ok: true }; // honeypot: bots fill the hidden field; pretend success
  if (!i.name?.trim()) throw new ConflictError("Please enter your name");
  if (!i.phone?.trim() && !i.email?.trim()) throw new ConflictError("Please give a phone number or an email address");
  if (i.message && i.message.length > 2000) throw new ConflictError("Message is too long");
  const [row] = await sq.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM listings WHERE share_token=:t AND deleted_at IS NULL AND share_enabled=1 AND status='published'", { replacements: { t: token }, type: QueryTypes.SELECT });
  if (!row) throw new NotFoundError("Listing");
  const ctx = systemContext(row.tenant_id, `corr_enquiry_${randomUUID()}`);
  const l: any = await withUow(sq, ctx, (u) => u.repo("Listing").findById(row.id, { transaction: u.tx }));
  const [first, ...rest] = i.name.trim().split(/\s+/);
  const r = await ingestLead(sq, row.tenant_id, {
    contact: { firstName: first, lastName: rest.join(" ") || undefined, phone: i.phone?.trim() || undefined, email: i.email?.trim() || undefined },
    purpose: l.get("purpose") === "rent" ? "rent" : "buy", sourceCode: "website", projectId: l.get("projectId") ?? undefined, assignedUserId: l.get("agentUserId") ?? undefined,
    notes: `Enquiry on listing ${l.get("reference") ?? row.id}${i.message?.trim() ? `: ${i.message.trim()}` : ""}`.slice(0, 4000),
  });
  await withUow(sq, ctx, async (u) => {
    await u.repo("ListingEnquiry").create({ id: randomUUID(), listingId: row.id, leadId: r.lead.id, contactId: r.lead.contactId, channel: "web", message: i.message?.trim() || null, duplicate: r.duplicate }, { transaction: u.tx });
    await u.sq.query("UPDATE listings SET enquiry_count = enquiry_count + 1 WHERE id=:id AND tenant_id=:t", { replacements: { id: row.id, t: row.tenant_id }, transaction: u.tx });
    if (l.get("agentUserId")) await notifyUser(u, { userId: l.get("agentUserId"), kind: "listing.enquiry", title: `New enquiry on ${l.get("reference") ?? "a listing"}`, body: `${i.name.trim()} asked about ${l.get("title") ?? "your listing"}.`, entityType: "lead", entityId: r.lead.id, dedupeKey: `enquiry:${r.lead.id}:${Date.now()}`, path: `/leads/${r.lead.id}`, email: "notifications.email.listing_enquiry" });
  });
  return { ok: true };
}

// ------------------------------------------------------------------ lifecycle
/** Keep a listing fresh: stamps the refresh time and pushes the expiry out (default 30 days). Published listings are re-sent to the portals. */
export async function refreshListing(sq: Sequelize, ctx: RequestContext, id: string, daysOverride?: number) {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    if (!["draft", "published", "unpublished", "expired"].includes(l.get("status"))) throw new ConflictError("Reopen this listing before refreshing it");
    const days = daysOverride ?? (await getSetting<number>(u.sq, ctx.tenantId, "listings.expiry_days"));
    const expiresOn = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    await u.repo("Listing").updateById(id, { lastRefreshedAt: new Date(), expiresOn, ...(l.get("status") === "expired" ? { status: "unpublished" } : {}) }, { transaction: u.tx });
    await u.audit({ action: "listing.refreshed", entityType: "listing", entityId: id, after: { expiresOn } });
    return plain(await u.repo("Listing").findById(id, { transaction: u.tx }));
  });
}

/** Copy a listing as a new draft (for example to list the same unit for rent after a sale falls through). Media and permits are not copied. */
export async function duplicateListing(sq: Sequelize, ctx: RequestContext, id: string, purpose?: "sale" | "rent") {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    const target = purpose ?? l.get("purpose");
    const clash: any = await u.repo("Listing").findOne({ where: { unitId: l.get("unitId"), purpose: target, status: { [Op.in]: ["draft", "published"] } }, transaction: u.tx });
    if (clash) throw new ConflictError("A live listing for this unit and purpose already exists");
    const nid = randomUUID();
    const n = await nextCounter(u, ctx.tenantId, "listing");
    await u.repo("Listing").create({
      id: nid, unitId: l.get("unitId"), purpose: target, status: "draft", title: l.get("title"), description: l.get("description"), price: l.get("price"), currency: l.get("currency"), agentUserId: l.get("agentUserId"), branchId: l.get("branchId"), projectId: l.get("projectId"),
      jurisdictionCode: l.get("jurisdictionCode"), brokerLicenceId: l.get("brokerLicenceId"), reference: `RLS-${String(n).padStart(6, "0")}`, features: l.get("features"), furnishing: l.get("furnishing"), parkingSpaces: l.get("parkingSpaces"), titleAr: l.get("titleAr"), descriptionAr: l.get("descriptionAr"),
      latitude: l.get("latitude"), longitude: l.get("longitude"), exclusivity: "none",
    }, { transaction: u.tx });
    await u.audit({ action: "listing.duplicated", entityType: "listing", entityId: nid, after: { from: id, purpose: target } });
    return plain(await u.repo("Listing").findById(nid, { transaction: u.tx }));
  });
}

/**
 * Daily lifecycle sweep: warns the agent a week before a listing's expiry, takes expired listings off the portals, and warns two weeks before an
 * exclusivity agreement ends. Idempotent (notifications carry dedupe keys, unpublishing only acts on published listings).
 */
export async function listingLifecycleSweep(sq: Sequelize, ctx: RequestContext, now = new Date()) {
  const out = { expired: 0, expiringSoon: 0, agreementsEnding: 0, archived: 0 };
  await withUow(sq, ctx, async (u) => {
    const autoExpire = await getSetting<boolean>(u.sq, ctx.tenantId, "listings.auto_expire");
    const archiveDays = await getSetting<number>(u.sq, ctx.tenantId, "listings.archive_after_days");
    const day = now.toISOString().slice(0, 10), in7 = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10), in14 = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    if (autoExpire) {
      for (const l of (await u.repo("Listing").findAll({ where: { status: "published", expiresOn: { [Op.ne]: null, [Op.lt]: day } }, transaction: u.tx })) as any[]) {
        await unpublishListingInUow(u, ctx, l, "expired: not refreshed in time", "expired");
        if (l.get("agentUserId")) await notifyInUow(u, { userId: l.get("agentUserId"), kind: "listing.expired", title: `${l.get("reference") ?? "A listing"} expired and was taken down`, body: "Refresh it and publish again.", entityType: "listing", entityId: l.get("id"), dedupeKey: `listing.expired:${l.get("id")}:${l.get("expiresOn")}` });
        out.expired++;
      }
      for (const l of (await u.repo("Listing").findAll({ where: { status: "published", expiresOn: { [Op.gte]: day, [Op.lte]: in7 } }, transaction: u.tx })) as any[]) {
        if (l.get("agentUserId") && await notifyUser(u, { userId: l.get("agentUserId"), kind: "listing.expiring", title: `${l.get("reference") ?? "A listing"} expires on ${l.get("expiresOn")}`, body: "Refresh it to keep it live.", entityType: "listing", entityId: l.get("id"), dedupeKey: `listing.expiring:${l.get("id")}:${l.get("expiresOn")}`, path: `/listings/${l.get("id")}`, email: "notifications.email.listing_expiring" })) out.expiringSoon++;
      }
    }
    for (const l of (await u.repo("Listing").findAll({ where: { status: { [Op.in]: ["draft", "published"] }, exclusivity: { [Op.ne]: "none" }, agreementExpiresOn: { [Op.gte]: day, [Op.lte]: in14 } }, transaction: u.tx })) as any[]) {
      if (l.get("agentUserId") && await notifyInUow(u, { userId: l.get("agentUserId"), kind: "listing.agreement_ending", title: `Agreement for ${l.get("reference") ?? "a listing"} ends on ${l.get("agreementExpiresOn")}`, body: "Renew it with the owner or the listing will lose its exclusivity.", entityType: "listing", entityId: l.get("id"), dedupeKey: `listing.agreement:${l.get("id")}:${l.get("agreementExpiresOn")}` })) out.agreementsEnding++;
    }
    if (archiveDays > 0) {
      const cutoff = new Date(now.getTime() - archiveDays * 86_400_000);
      const stale = (await u.repo("Listing").findAll({ where: { status: { [Op.in]: ["closed", "expired"] }, updatedAt: { [Op.lt]: cutoff } }, transaction: u.tx })) as any[];
      for (const l of stale) {
        await u.repo("Listing").updateById(l.get("id"), { status: "archived", archivedAt: now, statusBeforeArchive: l.get("status") }, { transaction: u.tx });
        await u.audit({ action: "listing.archived", entityType: "listing", entityId: l.get("id"), reason: `automatic: ${archiveDays} days after ${l.get("status")}` });
        out.archived++;
      }
    }
  });
  return out;
}

// ------------------------------------------------------------------ close, archive, reopen
/**
 * Closes a listing because the property was sold or let (or the owner withdrew it). A published listing is taken off the website and the portals first.
 * The deal, when given, must be for the same unit.
 */
export async function closeListing(sq: Sequelize, ctx: RequestContext, id: string, o: { outcome: "sold" | "rented" | "withdrawn"; dealId?: string; note?: string }) {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.publish", ref(l));
    if (!["draft", "published", "unpublished", "expired"].includes(l.get("status"))) throw new ConflictError(`A ${l.get("status")} listing cannot be closed`);
    if (o.outcome === "sold" && l.get("purpose") !== "sale") throw new ConflictError("Only a sale listing can be marked sold");
    if (o.outcome === "rented" && l.get("purpose") !== "rent") throw new ConflictError("Only a rental listing can be marked rented");
    if (o.dealId) {
      const deal: any = await u.repo("Deal").findById(o.dealId, { transaction: u.tx });
      if (!deal) throw new NotFoundError("Deal");
      if (deal.get("unitId") !== l.get("unitId")) throw new ConflictError("That deal is for a different unit");
    }
    const extra = { closedAt: new Date(), closedOutcome: o.outcome, closedNote: o.note?.trim().slice(0, 300) || null, closedDealId: o.dealId ?? null, shareEnabled: false };
    if (l.get("status") === "published") await unpublishListingInUow(u, ctx, l, `closed: ${o.outcome}`, "closed", extra);
    else await u.repo("Listing").updateById(id, { status: "closed", ...extra }, { transaction: u.tx });
    await u.audit({ action: "listing.closed", entityType: "listing", entityId: id, after: { outcome: o.outcome, dealId: o.dealId ?? null, note: o.note ?? null } });
    await u.emit({ type: "listing.closed", aggregateType: "listing", aggregateId: id, projectId: l.get("projectId"), payload: { outcome: o.outcome, dealId: o.dealId ?? null } });
    return plain(await u.repo("Listing").findById(id, { transaction: u.tx }));
  });
}

/** Moves a finished listing out of the working list. Live listings must be unpublished or closed first. */
export async function archiveListing(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    if (l.get("status") === "published") throw new ConflictError("Unpublish or close this listing before archiving it");
    if (l.get("status") === "archived") return plain(l);
    await u.repo("Listing").updateById(id, { status: "archived", archivedAt: new Date(), statusBeforeArchive: l.get("status"), shareEnabled: false }, { transaction: u.tx });
    await u.audit({ action: "listing.archived", entityType: "listing", entityId: id, after: { from: l.get("status") } });
    return plain(await u.repo("Listing").findById(id, { transaction: u.tx }));
  });
}

/** Brings a closed, expired or archived listing back as an unpublished listing (it must be published again, which re-checks compliance). */
export async function reopenListing(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const l = await scoped(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    if (!["closed", "expired", "archived"].includes(l.get("status"))) throw new ConflictError("Only a closed, expired or archived listing can be reopened");
    const clash: any = await u.repo("Listing").findOne({ where: { unitId: l.get("unitId"), purpose: l.get("purpose"), status: { [Op.in]: ["draft", "published"] }, id: { [Op.ne]: id } }, transaction: u.tx });
    if (clash) throw new ConflictError(`A live ${l.get("purpose")} listing already exists for this unit${clash.get("reference") ? ` (${clash.get("reference")})` : ""}`);
    await u.repo("Listing").updateById(id, { status: "unpublished", closedAt: null, closedOutcome: null, closedNote: null, closedDealId: null, archivedAt: null, statusBeforeArchive: null, expiresOn: null }, { transaction: u.tx });
    await u.audit({ action: "listing.reopened", entityType: "listing", entityId: id, after: { from: l.get("status") } });
    return plain(await u.repo("Listing").findById(id, { transaction: u.tx }));
  });
}

// ------------------------------------------------------------------ bulk
export type BulkListingAction = { type: "publish" } | { type: "unpublish"; reason?: string } | { type: "refresh" } | { type: "assign"; userId: string } | { type: "feature"; value: boolean } | { type: "archive" } | { type: "close"; outcome: "sold" | "rented" | "withdrawn" };

/** One action for many listings. Each goes through the single-listing rules (permissions, compliance gate); failures are reported per listing and never stop the rest. */
export async function bulkListingAction(sq: Sequelize, ctx: RequestContext, ids: string[], a: BulkListingAction) {
  const out = { done: 0, failed: [] as { id: string; reason: string }[] };
  for (const id of [...new Set(ids)].slice(0, 100)) {
    try {
      if (a.type === "publish") await publishListing(sq, ctx, id);
      else if (a.type === "unpublish") await (await import("./listings")).unpublishListing(sq, ctx, id, a.reason ?? "bulk");
      else if (a.type === "refresh") await refreshListing(sq, ctx, id);
      else if (a.type === "archive") await archiveListing(sq, ctx, id);
      else if (a.type === "close") await closeListing(sq, ctx, id, { outcome: a.outcome });
      else if (a.type === "feature") await updateListingDetails(sq, ctx, id, { featured: a.value });
      else await (await import("./listings")).updateListing(sq, ctx, id, { agentUserId: a.userId });
      out.done++;
    } catch (e) {
      out.failed.push({ id, reason: e instanceof Error ? (e as { evaluation?: { issues: { message: string }[] } }).evaluation?.issues?.[0]?.message ?? e.message : "Failed" });
    }
  }
  return out;
}

void ForbiddenError;
