import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize, ForbiddenError, hasPermission } from "@reales/rbac";
import { searchListingsAdvanced } from "./filters";
import { createListing } from "./listings";
import { updateListingDetails } from "./listing-details";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

/* ---------------------------------------------------------------------------------------------- property types */

export const PROPERTY_TYPES = [
  { value: "apartment", label: "Apartment", category: "residential" }, { value: "studio", label: "Studio", category: "residential" }, { value: "villa", label: "Villa", category: "residential" },
  { value: "townhouse", label: "Townhouse", category: "residential" }, { value: "penthouse", label: "Penthouse", category: "residential" }, { value: "duplex", label: "Duplex", category: "residential" },
  { value: "hotel_apartment", label: "Hotel apartment", category: "residential" }, { value: "compound", label: "Compound", category: "residential" }, { value: "full_floor", label: "Full floor", category: "residential" },
  { value: "half_floor", label: "Half floor", category: "residential" }, { value: "whole_building", label: "Whole building", category: "residential" }, { value: "bulk_units", label: "Bulk sale units", category: "residential" },
  { value: "staff_accommodation", label: "Staff accommodation", category: "residential" },
  { value: "office", label: "Office space", category: "commercial" }, { value: "retail", label: "Retail", category: "commercial" }, { value: "showroom", label: "Showroom", category: "commercial" },
  { value: "warehouse", label: "Warehouse", category: "commercial" }, { value: "factory", label: "Factory", category: "commercial" }, { value: "labour_camp", label: "Labour camp", category: "commercial" },
  { value: "land", label: "Land", category: "land" }, { value: "farm", label: "Farm", category: "land" },
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number]["value"];
export const propertyCategory = (t: string) => PROPERTY_TYPES.find((p) => p.value === t)?.category ?? "residential";
export const portalPropertyType = (t: string) => PROPERTY_TYPES.find((p) => p.value === t)?.label ?? t;
const NO_BEDS = new Set(["office", "retail", "showroom", "warehouse", "factory", "labour_camp", "land", "farm", "whole_building", "bulk_units", "compound"]);

/* ---------------------------------------------------------------------------------------------- location catalogue */

export const EMIRATES = ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah", "Fujairah", "Umm Al Quwain"] as const;
const JURISDICTION: Record<string, string | undefined> = { Dubai: "DUBAI_MAINLAND", "Abu Dhabi": "ABU_DHABI_MAINLAND" };

/** [emirate, community, latitude, longitude, sub-communities]. Coordinates are approximate centres to place a pin; correct them per company under Setup. */
const SEED: [string, string, number, number, string[]][] = [
  ["Dubai", "Dubai Marina", 25.0805, 55.1403, ["Marina Promenade", "Marina Walk", "Marina Gate"]], ["Dubai", "Jumeirah Beach Residence (JBR)", 25.078, 55.133, []], ["Dubai", "Jumeirah Lakes Towers (JLT)", 25.069, 55.145, []],
  ["Dubai", "Palm Jumeirah", 25.1124, 55.139, ["Shoreline Apartments", "Golden Mile", "Palm Tower", "Signature Villas"]], ["Dubai", "Downtown Dubai", 25.1972, 55.2744, ["Burj Khalifa Area", "Old Town", "Boulevard"]],
  ["Dubai", "Business Bay", 25.185, 55.265, []], ["Dubai", "DIFC", 25.2138, 55.28, []], ["Dubai", "Dubai Hills Estate", 25.123, 55.245, ["Park Heights", "Maple", "Sidra", "Golf Place"]],
  ["Dubai", "Jumeirah Village Circle (JVC)", 25.06, 55.21, []], ["Dubai", "Jumeirah Village Triangle (JVT)", 25.044, 55.173, []], ["Dubai", "Arabian Ranches", 25.056, 55.268, ["Alvorada", "Palmera", "Mirador", "Saheel"]],
  ["Dubai", "Dubai Creek Harbour", 25.2, 55.345, []], ["Dubai", "Al Barsha", 25.112, 55.2, ["Barsha Heights (Tecom)", "Barsha South"]], ["Dubai", "Dubai Sports City", 25.04, 55.215, []],
  ["Dubai", "Motor City", 25.048, 55.24, []], ["Dubai", "Dubai Silicon Oasis", 25.127, 55.383, []], ["Dubai", "Damac Hills", 25.021, 55.245, []], ["Dubai", "Emirates Hills", 25.068, 55.17, []],
  ["Dubai", "Meydan", 25.16, 55.3, []], ["Dubai", "Al Furjan", 25.027, 55.145, []], ["Dubai", "Dubai South", 24.89, 55.16, []], ["Dubai", "Deira", 25.27, 55.31, []], ["Dubai", "Bur Dubai", 25.253, 55.297, []],
  ["Dubai", "Jumeirah", 25.2, 55.24, []], ["Dubai", "Al Quoz", 25.14, 55.23, []], ["Dubai", "Mirdif", 25.22, 55.42, []], ["Dubai", "International City", 25.165, 55.41, []], ["Dubai", "Discovery Gardens", 25.039, 55.138, []],
  ["Dubai", "Dubailand", 25.08, 55.33, []], ["Dubai", "Town Square", 25.009, 55.29, []], ["Dubai", "Dubai Production City (IMPZ)", 25.034, 55.188, []],
  ["Abu Dhabi", "Yas Island", 24.4672, 54.603, []], ["Abu Dhabi", "Saadiyat Island", 24.54, 54.43, []], ["Abu Dhabi", "Al Reem Island", 24.498, 54.4, []], ["Abu Dhabi", "Al Raha Beach", 24.463, 54.6, []],
  ["Abu Dhabi", "Khalifa City", 24.416, 54.58, []], ["Abu Dhabi", "Corniche Area", 24.475, 54.335, []], ["Abu Dhabi", "Al Maryah Island", 24.5, 54.39, []], ["Abu Dhabi", "Masdar City", 24.427, 54.617, []],
  ["Abu Dhabi", "Al Reef", 24.351, 54.665, []], ["Abu Dhabi", "Mohammed Bin Zayed City", 24.33, 54.53, []],
  ["Sharjah", "Al Majaz", 25.325, 55.385, []], ["Sharjah", "Al Khan", 25.328, 55.372, []], ["Sharjah", "Al Nahda", 25.297, 55.368, []], ["Sharjah", "Muwaileh", 25.29, 55.45, []], ["Sharjah", "Aljada", 25.3, 55.46, []],
  ["Ajman", "Ajman Downtown", 25.41, 55.445, []], ["Ajman", "Al Nuaimiya", 25.4, 55.46, []], ["Ajman", "Al Rashidiya", 25.398, 55.47, []],
  ["Ras Al Khaimah", "Al Marjan Island", 25.68, 55.75, []], ["Ras Al Khaimah", "Mina Al Arab", 25.7, 55.76, []], ["Ras Al Khaimah", "Al Hamra Village", 25.69, 55.78, []],
  ["Fujairah", "Fujairah City", 25.12, 56.33, []], ["Umm Al Quwain", "Umm Al Quwain Marina", 25.59, 55.6, []],
];
const pathKey = (e: string, c: string, s?: string | null) => [e, c, s ?? ""].map((x) => x.trim().toLowerCase()).join("|");

/** First use: the common UAE communities (and a few well-known sub-communities) so the dropdowns are never empty. Companies edit, add and map portal ids afterwards. */
export async function ensureLocations(u: Uow) {
  if ((await u.repo("Location").count({ transaction: u.tx })) > 0) return;
  for (const [emirate, community, lat, lng, subs] of SEED) {
    await u.repo("Location").create({ id: randomUUID(), emirate, community, subCommunity: null, pathKey: pathKey(emirate, community), latitude: lat, longitude: lng, active: true }, { transaction: u.tx });
    for (const sub of subs) await u.repo("Location").create({ id: randomUUID(), emirate, community, subCommunity: sub, pathKey: pathKey(emirate, community, sub), latitude: lat, longitude: lng, active: true }, { transaction: u.tx });
  }
}

export async function listLocations(sq: Sequelize, ctx: RequestContext, f: { emirate?: string; q?: string; all?: boolean } = {}) {
  return withUow(sq, ctx, async (u) => {
    await ensureLocations(u);
    const where: any = {};
    if (!f.all) where.active = true;
    if (f.emirate) where.emirate = f.emirate;
    if (f.q?.trim()) where[Op.or] = [{ community: { [Op.like]: `%${f.q.trim()}%` } }, { subCommunity: { [Op.like]: `%${f.q.trim()}%` } }];
    const rows = (await u.repo("Location").findAll({ where, order: [["emirate", "ASC"], ["community", "ASC"], ["subCommunity", "ASC"]], limit: 2000, transaction: u.tx })) as any[];
    return rows.map((r) => ({ ...plain(r), latitude: r.get("latitude") == null ? null : Number(r.get("latitude")), longitude: r.get("longitude") == null ? null : Number(r.get("longitude")) }));
  });
}

export interface LocationInput { id?: string; emirate: string; community: string; subCommunity?: string | null; latitude?: number | null; longitude?: number | null; bayutId?: string | null; pfId?: string | null; active?: boolean }

/** Add or change a location. Anyone who can manage listings can add a missing community; portal ids and coordinates need the portal permission. */
export async function saveLocation(sq: Sequelize, ctx: RequestContext, i: LocationInput) {
  if (!hasPermission(ctx, "listing.manage")) throw new ForbiddenError("Missing permission: listing.manage");
  if (!(EMIRATES as readonly string[]).includes(i.emirate)) throw new ConflictError("Choose one of the seven emirates");
  if (!i.community.trim()) throw new ConflictError("Community is required");
  if ((i.latitude == null) !== (i.longitude == null)) throw new ConflictError("Give both latitude and longitude, or neither");
  if (i.latitude != null && (i.latitude < 22 || i.latitude > 26.5 || (i.longitude ?? 0) < 51 || (i.longitude ?? 0) > 57)) throw new ConflictError("Those coordinates are outside the UAE");
  return withUow(sq, ctx, async (u) => {
    await ensureLocations(u);
    const key = pathKey(i.emirate, i.community, i.subCommunity);
    const existing: any = i.id ? await u.repo("Location").findById(i.id, { transaction: u.tx }) : await u.repo("Location").findOne({ where: { pathKey: key }, transaction: u.tx });
    if (i.id && !existing) throw new NotFoundError("Location");
    const touchesPortal = i.bayutId !== undefined || i.pfId !== undefined || i.latitude !== undefined || i.active !== undefined;
    if (touchesPortal && existing) authorize(ctx, "portal.manage");
    const vals = { emirate: i.emirate, community: i.community.trim(), subCommunity: i.subCommunity?.trim() || null, pathKey: key, ...(i.latitude !== undefined ? { latitude: i.latitude, longitude: i.longitude } : {}), ...(i.bayutId !== undefined ? { bayutId: i.bayutId?.trim() || null } : {}), ...(i.pfId !== undefined ? { pfId: i.pfId?.trim() || null } : {}), ...(i.active !== undefined ? { active: i.active } : {}) };
    if (existing) { await u.repo("Location").updateById(existing.get("id"), vals, { transaction: u.tx }); return plain(await u.repo("Location").findById(existing.get("id"), { transaction: u.tx })); }
    const id = randomUUID();
    await u.repo("Location").create({ id, active: true, ...vals }, { transaction: u.tx });
    await u.audit({ action: "location.added", entityType: "location", entityId: id, after: { path: key } });
    return plain(await u.repo("Location").findById(id, { transaction: u.tx }));
  });
}

/* ---------------------------------------------------------------------------------------------- add a listing with its property */

export interface NewPropertyListing {
  emirate: string; community: string; subCommunity?: string | null; buildingName: string; unitNumber: string; type: PropertyType; purpose: "sale" | "rent"; price: number;
  bedrooms?: number | null; bathrooms?: number | null; builtUpAreaSqft: number; plotAreaSqft?: number | null; floor?: number | null; view?: string | null; currency?: string;
  title?: string; description?: string; agentUserId?: string; completionStatus?: "ready" | "off_plan"; ownership?: "freehold" | "leasehold" | "usufruct" | "musataha" | null; yearBuilt?: number | null;
  latitude?: number | null; longitude?: number | null;
}

/**
 * Creates a listing for a property that may not be in inventory yet: finds or creates the location, project, building and unit, then the draft listing.
 * Price per square foot is calculated from price and built-up area. Existing buildings and units with the same name and number are reused.
 */
export async function createListingFromProperty(sq: Sequelize, ctx: RequestContext, i: NewPropertyListing) {
  authorize(ctx, "listing.manage", { ownerUserId: i.agentUserId ?? ctx.userId, branchId: ctx.membership.branchIds[0] ?? null, projectId: null });
  const jurisdictionCode = JURISDICTION[i.emirate];
  if (!(EMIRATES as readonly string[]).includes(i.emirate)) throw new ConflictError("Choose one of the seven emirates");
  if (!jurisdictionCode) throw new ConflictError(`Listing rules for ${i.emirate} are not set up yet. Ask an administrator to add the ${i.emirate} jurisdiction, or choose a unit that already exists.`);
  if (!i.community.trim() || !i.buildingName.trim() || !i.unitNumber.trim()) throw new ConflictError("Community, building and unit number are required");
  if (!PROPERTY_TYPES.some((p) => p.value === i.type)) throw new ConflictError("Choose a property type");
  if (!(i.price > 0)) throw new ConflictError("Enter the price");
  if (!(i.builtUpAreaSqft > 0)) throw new ConflictError("Enter the built-up area (BUA)");
  if (!NO_BEDS.has(i.type) && i.type !== "studio" && i.bedrooms == null) throw new ConflictError("Enter the number of bedrooms");
  const unitId = await withUow(sq, ctx, async (u) => {
    await ensureLocations(u);
    const key = pathKey(i.emirate, i.community, i.subCommunity);
    let loc: any = await u.repo("Location").findOne({ where: { pathKey: key }, transaction: u.tx });
    if (!loc) {
      const parent: any = i.subCommunity?.trim() ? await u.repo("Location").findOne({ where: { pathKey: pathKey(i.emirate, i.community) }, transaction: u.tx }) : null;
      const id = randomUUID();
      await u.repo("Location").create({ id, emirate: i.emirate, community: i.community.trim(), subCommunity: i.subCommunity?.trim() || null, pathKey: key, latitude: parent?.get("latitude") ?? null, longitude: parent?.get("longitude") ?? null, active: true }, { transaction: u.tx });
      loc = await u.repo("Location").findById(id, { transaction: u.tx });
    }
    const name = i.buildingName.trim();
    let building: any = await u.repo("Building").findOne({ where: { name, community: i.community.trim(), city: i.emirate }, transaction: u.tx });
    if (!building) {
      let project: any = await u.repo("ReProject").findOne({ where: { name, jurisdictionCode }, transaction: u.tx });
      if (!project) {
        const pid = randomUUID();
        await u.repo("ReProject").create({ id: pid, name, jurisdictionCode, kind: i.completionStatus === "off_plan" ? "off_plan" : "ready", status: "selling" }, { transaction: u.tx });
        project = await u.repo("ReProject").findById(pid, { transaction: u.tx });
      }
      const bid = randomUUID();
      await u.repo("Building").create({ id: bid, reProjectId: project.get("id"), name, community: i.community.trim(), subCommunity: i.subCommunity?.trim() || null, city: i.emirate, country: "AE", locationId: loc.get("id"), latitude: i.latitude ?? null, longitude: i.longitude ?? null }, { transaction: u.tx });
      building = await u.repo("Building").findById(bid, { transaction: u.tx });
    }
    let unit: any = await u.repo("Unit").findOne({ where: { buildingId: building.get("id"), unitNumber: i.unitNumber.trim() }, transaction: u.tx });
    if (unit) {
      const fill: Record<string, unknown> = {};
      for (const [k, v] of Object.entries({ bedrooms: i.bedrooms, bathrooms: i.bathrooms, areaSqft: i.builtUpAreaSqft, plotAreaSqft: i.plotAreaSqft, floor: i.floor, view: i.view })) if (v != null && unit.get(k) == null) fill[k] = v;
      if (Object.keys(fill).length) await u.repo("Unit").updateById(unit.get("id"), fill, { transaction: u.tx });
    } else {
      const uid = randomUUID();
      await u.repo("Unit").create({ id: uid, buildingId: building.get("id"), unitNumber: i.unitNumber.trim(), floor: i.floor ?? null, type: i.type, bedrooms: i.bedrooms ?? null, bathrooms: i.bathrooms ?? null, areaSqft: i.builtUpAreaSqft, plotAreaSqft: i.plotAreaSqft ?? null, view: i.view?.trim() || null, status: "available", listPrice: i.price, currency: i.currency ?? "AED" }, { transaction: u.tx });
      unit = await u.repo("Unit").findById(uid, { transaction: u.tx });
    }
    await u.audit({ action: "property.recorded_for_listing", entityType: "unit", entityId: unit.get("id"), after: { building: name, unit: i.unitNumber, community: i.community } });
    return unit.get("id") as string;
  });
  const listing: any = await createListing(sq, ctx, { unitId, purpose: i.purpose, price: i.price, currency: i.currency, title: i.title, description: i.description, agentUserId: i.agentUserId });
  const extra = { ...(i.completionStatus ? { completionStatus: i.completionStatus } : {}), ...(i.ownership ? { ownership: i.ownership } : {}), ...(i.yearBuilt ? { yearBuilt: i.yearBuilt } : {}), ...(i.latitude != null && i.longitude != null ? { latitude: i.latitude, longitude: i.longitude } : {}) };
  if (Object.keys(extra).length) await updateListingDetails(sq, ctx, listing.id, extra);
  return { ...listing, pricePerSqft: Math.round(i.price / i.builtUpAreaSqft) };
}

/* ---------------------------------------------------------------------------------------------- map pins */

export interface Pin { id: string; reference: string | null; title: string; price: number | null; currency: string; purpose: string; status: string; lat: number; lng: number; type: string | null; bedrooms: number | null; areaSqft: number | null; community: string | null; cover: string | null; precise: boolean }

/** Coordinates for a set of listings: the listing's own pin, else its building's, else the centre of its location. `precise` is false when only the community centre is known. */
export async function pinsForListings(sq: Sequelize, ctx: RequestContext, ids: string[]): Promise<Pin[]> {
  if (!ids.length) return [];
  return withUow(sq, ctx, async (u) => {
    const rows = (await u.sq.query(
      `SELECT l.id, l.reference, l.title, l.price, l.currency, l.purpose, l.status, l.cover_media_id AS cover, un.type, un.bedrooms, un.area_sqft AS area, b.community,
              COALESCE(l.latitude, b.latitude, loc.latitude) AS lat, COALESCE(l.longitude, b.longitude, loc.longitude) AS lng, (l.latitude IS NOT NULL OR b.latitude IS NOT NULL) AS precise
         FROM listings l JOIN units un ON un.id=l.unit_id AND un.tenant_id=l.tenant_id JOIN buildings b ON b.id=un.building_id AND b.tenant_id=l.tenant_id
         LEFT JOIN locations loc ON loc.id=b.location_id AND loc.tenant_id=b.tenant_id
        WHERE l.tenant_id=:t AND l.id IN (:ids) AND l.deleted_at IS NULL`, { replacements: { t: ctx.tenantId, ids }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    return rows.filter((r) => r.lat != null && r.lng != null).map((r) => ({ id: r.id, reference: r.reference, title: r.title ?? "(untitled)", price: r.price == null ? null : Number(r.price), currency: r.currency, purpose: r.purpose, status: r.status, lat: Number(r.lat), lng: Number(r.lng), type: r.type, bedrooms: r.bedrooms, areaSqft: r.area == null ? null : Number(r.area), community: r.community, cover: r.cover, precise: !!Number(r.precise) }));
  });
}

/** Pins for whatever the listings filters currently match (up to 300), respecting the caller's visibility. */
export async function listingPins(sq: Sequelize, ctx: RequestContext, f: Parameters<typeof searchListingsAdvanced>[2]) {
  const res = await searchListingsAdvanced(sq, ctx, { ...f, limit: 300, offset: 0 });
  const pins = await pinsForListings(sq, ctx, res.rows.map((r: any) => r.id));
  return { pins, total: res.total, shown: res.rows.length, withoutLocation: res.rows.length - pins.length };
}
