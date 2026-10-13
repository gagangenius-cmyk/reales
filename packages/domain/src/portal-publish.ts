import { randomUUID } from "node:crypto";
import { Sequelize } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { CanonicalListing, getPortalProvider, listPortalProviders, PortalAction, snapshotHash } from "./portals";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

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
  return {
    listingId: listing.get("id"), reference: `L-${String(listing.get("id")).slice(0, 8).toUpperCase()}`, purpose: listing.get("purpose"),
    title: listing.get("title") ?? "", description: listing.get("description") ?? "", price: Number(listing.get("price")), currency: listing.get("currency"),
    jurisdiction: listing.get("jurisdictionCode"),
    property: { type: unit.get("type"), bedrooms: unit.get("bedrooms"), bathrooms: unit.get("bathrooms"), areaSqft: unit.get("areaSqft") != null ? Number(unit.get("areaSqft")) : null, unitNumber: unit.get("unitNumber"), floor: unit.get("floor"), view: unit.get("view") },
    location: { building: building.get("name"), community: building.get("community"), city: building.get("city"), project: project.get("name"), offPlan: project.get("kind") === "off_plan", projectRegistrationNo: project.get("registrationNo") },
    agent: { name: profile ? [profile.get("firstName"), profile.get("lastName")].filter(Boolean).join(" ") || null : null, email: agent?.get("email") ?? null, licenceNo: (agentLicences[0] as any)?.get("licenceNo") ?? null },
    brokerage: { name: licence?.get("holderName") ?? null, licenceNo: licence?.get("licenceNo") ?? null },
    permit: permit ? { number: permit.get("permitNo"), authority: permit.get("authority"), expiresAt: String(permit.get("expiresAt")) } : null,
    media: media.map((m: any) => ({ kind: m.get("kind"), key: m.get("storageKey"), position: m.get("position") })),
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
    // A portal only needs an "unpublish" if we previously sent it something.
    if (action === "unpublish") {
      const prior = await u.repo("PortalPublication").count({ where: { listingId: listing.get("id"), portalAccountId: acct.get("id") }, transaction: u.tx });
      if (!prior) continue;
    }
    const id = randomUUID();
    const hash = snapshotHash(snapshot);
    let status: "exported" | "sent" | "failed" = "exported";
    let error: string | null = null;
    let payload: { format: string; payload: string } | null = null;
    if (acct.get("mode") === "api") {
      status = "failed";
      error = "Live API sync is not enabled: it requires an authorised partner integration with the portal.";
    } else {
      payload = provider.transform(snapshot, action);
    }
    await u.repo("PortalPublication").create({
      id, listingId: listing.get("id"), portalAccountId: acct.get("id"), action, status, snapshot, snapshotHash: hash,
      payloadFormat: payload?.format ?? null, payload: payload?.payload ?? null, error, actorId: ctx.userId === "system" ? null : ctx.userId, createdAt: mysqlDate(new Date()),
    }, { transaction: u.tx });
    await u.repo("PortalSyncLog").create({ id: randomUUID(), portalAccountId: acct.get("id"), listingId: listing.get("id"), action, outcome: status, detail: error, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
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
