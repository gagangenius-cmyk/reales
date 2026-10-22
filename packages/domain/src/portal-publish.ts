import { randomUUID } from "node:crypto";
import { Sequelize } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { CanonicalListing, getPortalProvider, listPortalProviders, PortalAction, snapshotHash } from "./portals";
import { plain } from "./scope";
import { channelAllowed, recordChannelResult } from "./syndication";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

/** Absolute, unguessable URL a portal can fetch a photo from (it only works for a published listing with a link token). */
function publicMediaUrl(listing: any, m: any): string | null {
  const base = (process.env.PUBLIC_BASE_URL ?? process.env.APP_URL ?? "").replace(/\/$/, "");
  const token = listing.get("shareToken");
  return base && token && m.get("mime") ? `${base}/media/${token}/${m.get("id")}` : null;
}

export async function buildCanonicalListing(u: Uow, listing: any): Promise<CanonicalListing> {
  const unit: any = await u.repo("Unit").findById(listing.get("unitId"), { transaction: u.tx });
  const building: any = await u.repo("Building").findById(unit.get("buildingId"), { transaction: u.tx });
  const project: any = await u.repo("ReProject").findById(building.get("reProjectId"), { transaction: u.tx });
  const agent: any = listing.get("agentUserId") ? await u.repo("User").findById(listing.get("agentUserId"), { transaction: u.tx }) : null;
  const profile: any = agent ? await u.repo("UserProfile").findOne({ where: { userId: agent.get("id") }, transaction: u.tx }) : null;
  const licence: any = listing.get("brokerLicenceId") ? await u.repo("BrokerLicence").findById(listing.get("brokerLicenceId"), { transaction: u.tx }) : null;
  const agentLicences = agent ? await u.repo("BrokerLicence").findAll({ where: { userId: agent.get("id"), holderType: "agent", validationStatus: "valid" }, transaction: u.tx }) : [];
  const permits = await u.repo("ListingPermit").findAll({ where: { listingId: listing.get("id"), status: "valid" }, order: [["expiresAt", "DESC"]], transaction: u.tx });
  const media = await u.repo("ListingMedia").findAll({ where: { listingId: listing.get("id") }, order: [["position", "ASC"]], transaction: u.tx });
  const permit: any = permits[0];
  const loc: any = building.get("locationId") ? await u.repo("Location").findById(building.get("locationId"), { transaction: u.tx }) : null;
  const area = unit.get("areaSqft") != null ? Number(unit.get("areaSqft")) : null;
  const lat = listing.get("latitude") ?? building.get("latitude") ?? loc?.get("latitude") ?? null, lng = listing.get("longitude") ?? building.get("longitude") ?? loc?.get("longitude") ?? null;
  return {
    listingId: listing.get("id"), reference: listing.get("reference") ?? `L-${String(listing.get("id")).slice(0, 8).toUpperCase()}`, purpose: listing.get("purpose"),
    title: listing.get("title") ?? "", description: listing.get("description") ?? "", price: Number(listing.get("price")), currency: listing.get("currency"),
    jurisdiction: listing.get("jurisdictionCode"),
    property: { type: unit.get("type"), bedrooms: unit.get("bedrooms"), bathrooms: unit.get("bathrooms"), areaSqft: unit.get("areaSqft") != null ? Number(unit.get("areaSqft")) : null, unitNumber: unit.get("unitNumber"), floor: unit.get("floor"), view: unit.get("view") },
    location: { building: building.get("name"), community: building.get("community"), subCommunity: building.get("subCommunity") ?? null, city: building.get("city"), country: building.get("country") ?? "AE", bayutLocationId: loc?.get("bayutId") ?? null, pfLocationId: loc?.get("pfId") ?? null, project: project.get("name"), offPlan: project.get("kind") === "off_plan", projectRegistrationNo: project.get("registrationNo") },
    agent: { name: profile ? [profile.get("firstName"), profile.get("lastName")].filter(Boolean).join(" ") || null : null, email: agent?.get("email") ?? null, licenceNo: (agentLicences[0] as any)?.get("licenceNo") ?? null },
    brokerage: { name: licence?.get("holderName") ?? null, licenceNo: licence?.get("licenceNo") ?? null },
    permit: permit ? { number: permit.get("permitNo"), authority: permit.get("authority"), expiresAt: String(permit.get("expiresAt")) } : null,
    media: media.map((m: any) => ({ kind: m.get("kind"), key: m.get("storageKey"), position: m.get("position"), id: m.get("id"), caption: m.get("caption") ?? null, url: publicMediaUrl(listing, m) })),
    details: {
      features: Array.isArray(listing.get("features")) ? listing.get("features") : [], furnishing: listing.get("furnishing") ?? null, parkingSpaces: listing.get("parkingSpaces") ?? null, rentFrequency: listing.get("rentFrequency") ?? null,
      cheques: listing.get("cheques") ?? null, securityDeposit: listing.get("securityDeposit") != null ? Number(listing.get("securityDeposit")) : null, serviceCharge: listing.get("serviceCharge") != null ? Number(listing.get("serviceCharge")) : null,
      videoUrl: listing.get("videoUrl") ?? null, virtualTourUrl: listing.get("virtualTourUrl") ?? null, titleAr: listing.get("titleAr") ?? null, descriptionAr: listing.get("descriptionAr") ?? null,
      latitude: lat != null ? Number(lat) : null, longitude: lng != null ? Number(lng) : null, ownership: listing.get("ownership") ?? null, yearBuilt: listing.get("yearBuilt") ?? null, availableFrom: listing.get("availableFrom") ? String(listing.get("availableFrom")).slice(0, 10) : null, utilitiesIncluded: listing.get("utilitiesIncluded") ?? null, plotAreaSqft: unit.get("plotAreaSqft") != null ? Number(unit.get("plotAreaSqft")) : null, pricePerSqft: area && Number(listing.get("price")) ? Math.round(Number(listing.get("price")) / area) : null,
      completionStatus: listing.get("completionStatus") ?? (project.get("kind") === "off_plan" ? "off_plan" : "ready"), agentPhone: null, agentPhotoUrl: null, exclusivity: listing.get("exclusivity") ?? "none", featured: !!listing.get("featured"),
    },
    capturedAt: new Date().toISOString(),
  };
}

export interface PublicationResult { portalAccountId: string; provider: string; action: PortalAction; status: string; snapshotHash: string; publicationId: string }

/**
 * Create an immutable snapshot per active portal account. "export" mode records exactly what was (or would be) sent so support can
 * answer "what did we send at 14:32?"; live "api" mode is intentionally not implemented until an authorised partner integration exists.
 */
export async function publishToPortals(u: Uow, ctx: RequestContext, listing: any, snapshot: CanonicalListing, action: PortalAction): Promise<PublicationResult[]> {
  const accounts = await u.repo("PortalAccount").findAll({ where: { status: "active" }, transaction: u.tx });
  const out: PublicationResult[] = [];
  for (const acct of accounts as any[]) {
    const provider = getPortalProvider(acct.get("provider"));
    if (!provider) continue;
    if (!(await channelAllowed(u, listing.get("id"), acct.get("id")))) continue; // the agent switched this portal off for this listing
    // A portal only needs an "unpublish" if we previously sent it something.
    if (action === "unpublish") {
      const prior = await u.repo("PortalPublication").count({ where: { listingId: listing.get("id"), portalAccountId: acct.get("id") }, transaction: u.tx });
      if (!prior) continue;
    }
    const id = randomUUID();
    const hash = snapshotHash(snapshot);
    let status: "exported" | "sent" | "failed" | "queued" = "exported";
    let error: string | null = null;
    let payload: { format: string; payload: string } | null = null;
    payload = provider.transform(snapshot, action);
    if (acct.get("mode") === "api") {
      if (!acct.get("credentialsEnc")) { status = "failed"; error = "Live API mode needs saved credentials."; }
      else status = "queued"; // delivered after commit by deliverQueuedPublications
    }
    await u.repo("PortalPublication").create({
      id, listingId: listing.get("id"), portalAccountId: acct.get("id"), action, status, snapshot, snapshotHash: hash,
      payloadFormat: payload?.format ?? null, payload: payload?.payload ?? null, error, actorId: ctx.userId === "system" ? null : ctx.userId, createdAt: mysqlDate(new Date()),
    }, { transaction: u.tx });
    await u.repo("PortalSyncLog").create({ id: randomUUID(), portalAccountId: acct.get("id"), listingId: listing.get("id"), action, outcome: status, detail: error, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await recordChannelResult(u, listing.get("id"), acct.get("id"), { status: status === "queued" ? "queued" : status === "failed" ? "failed" : action === "unpublish" ? "removed" : "in feed", error, pendingPublicationId: status === "queued" ? id : null });
    if (status === "failed") await u.emit({ type: "listing.portal_rejected", aggregateType: "listing", aggregateId: listing.get("id"), projectId: listing.get("projectId"), payload: { provider: provider.code, error } });
    out.push({ portalAccountId: acct.get("id"), provider: provider.code, action, status, snapshotHash: hash, publicationId: id });
  }
  return out;
}

export async function createPortalAccount(sq: Sequelize, ctx: RequestContext, input: { provider: string; name: string; mode?: "export" | "api"; config?: Record<string, unknown> }) {
  authorize(ctx, "portal.manage");
  if (!getPortalProvider(input.provider)) throw new ConflictError(`Unknown portal provider. Available: ${listPortalProviders().map((p) => p.code).join(", ")}`);
  return withUow(sq, ctx, async (u) => {
    const a = await u.repo("PortalAccount").create({ id: randomUUID(), provider: input.provider, name: input.name, mode: input.mode ?? "export", config: input.config ?? {}, status: "active" }, { transaction: u.tx });
    await u.audit({ action: "portal_account.created", entityType: "portal_account", entityId: (a as any).get("id"), after: { provider: input.provider, mode: input.mode ?? "export" } });
    return plain(a);
  });
}

export async function listPortalAccounts(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "portal.manage");
  return withUow(sq, ctx, async (u) => ({
    providers: listPortalProviders(),
    accounts: (await u.repo("PortalAccount").findAll({ transaction: u.tx })).map(plain),
  }));
}

/** A portal feed for manual upload: latest non-unpublished snapshot per listing for one account. */
export async function buildPortalFeed(sq: Sequelize, ctx: RequestContext, accountId: string) {
  authorize(ctx, "portal.manage");
  return withUow(sq, ctx, async (u) => {
    const acct: any = await u.repo("PortalAccount").findById(accountId, { transaction: u.tx });
    if (!acct) throw new NotFoundError("Portal account");
    const rows = await u.repo("PortalPublication").findAll({ where: { portalAccountId: accountId }, order: [["createdAt", "DESC"]], transaction: u.tx });
    const latest = new Map<string, any>();
    for (const r of rows as any[]) if (!latest.has(r.get("listingId"))) latest.set(r.get("listingId"), r);
    const live = [...latest.values()].filter((r) => r.get("action") !== "unpublish" && r.get("status") === "exported");
    const format = live[0]?.get("payloadFormat") ?? (acct.get("provider") === "bayut" ? "xml" : "json");
    const items = live.map((r) => r.get("payload") as string);
    const body = format === "xml" ? `<?xml version="1.0" encoding="UTF-8"?>\n<Properties>\n${items.join("\n")}\n</Properties>` : `[${items.join(",")}]`;
    return { provider: acct.get("provider"), format, count: items.length, body };
  });
}
