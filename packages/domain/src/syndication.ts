import { randomBytes, randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, systemContext, type RequestContext } from "@reales/database";
import { decryptField, encryptField } from "@reales/auth";
import { logger } from "@reales/observability";
import { authorize, hasPermission } from "@reales/rbac";
import { buildCanonicalListing } from "./portal-publish";
import { CanonicalListing, getPortalProvider, listPortalProviders, PortalAction } from "./portals";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

// ------------------------------------------------------------------ credentials
export interface PortalCredentials {
  baseUrl: string; apiKey: string; apiSecret: string;
  /** Paths are configurable because the portal's API contract is supplied privately and can change. */
  tokenPath?: string; listingsPath?: string; locationsPath?: string;
  /** community name -> portal location id, used before falling back to a search by name. */
  locationMap?: Record<string, string | number>;
}

const maskKey = (k: string) => (k.length <= 6 ? "••••" : `${k.slice(0, 3)}••••${k.slice(-3)}`);
const readCreds = (acct: any): PortalCredentials | null => { const enc = acct.get("credentialsEnc"); if (!enc) return null; try { return JSON.parse(decryptField(enc)) as PortalCredentials; } catch { return null; } };
const baseUrlOf = () => (process.env.PUBLIC_BASE_URL ?? process.env.APP_URL ?? "").replace(/\/$/, "");
const feedUrlFor = (acct: any) => (acct.get("feedToken") && baseUrlOf() ? `${baseUrlOf()}/api/v1/feeds/${acct.get("feedToken")}` : null);

/** Store the portal's API credentials encrypted. They are never returned again: the overview only shows a masked key. */
export async function savePortalCredentials(sq: Sequelize, ctx: RequestContext, accountId: string, c: PortalCredentials) {
  authorize(ctx, "portal.manage");
  if (!c.apiKey?.trim() || !c.apiSecret?.trim()) throw new ConflictError("Both the API key and the API secret are required");
  let base: URL;
  try { base = new URL(c.baseUrl); if (base.protocol !== "https:" && !/^localhost|127\.0\.0\.1$/.test(base.hostname)) throw new Error(); } catch { throw new ConflictError("The API address must be a full https:// URL"); }
  return withUow(sq, ctx, async (u) => {
    const acct: any = await u.repo("PortalAccount").findById(accountId, { transaction: u.tx });
    if (!acct) throw new NotFoundError("Portal account");
    const clean: PortalCredentials = { ...c, baseUrl: base.origin + base.pathname.replace(/\/$/, ""), apiKey: c.apiKey.trim(), apiSecret: c.apiSecret.trim() };
    await u.repo("PortalAccount").updateById(accountId, { credentialsEnc: encryptField(JSON.stringify(clean)), lastTestOk: null, lastTestedAt: null, lastTestMessage: null, feedToken: acct.get("feedToken") ?? randomBytes(24).toString("base64url") }, { transaction: u.tx });
    await u.audit({ action: "portal_account.credentials_saved", entityType: "portal_account", entityId: accountId, after: { provider: acct.get("provider"), apiKey: maskKey(clean.apiKey) } });
    return { saved: true, apiKey: maskKey(clean.apiKey) };
  });
}

export async function setPortalMode(sq: Sequelize, ctx: RequestContext, accountId: string, mode: "export" | "api") {
  authorize(ctx, "portal.manage");
  return withUow(sq, ctx, async (u) => {
    const acct: any = await u.repo("PortalAccount").findById(accountId, { transaction: u.tx });
    if (!acct) throw new NotFoundError("Portal account");
    if (mode === "api" && !acct.get("credentialsEnc")) throw new ConflictError("Add the API credentials first");
    if (mode === "api" && acct.get("provider") !== "property_finder") throw new ConflictError("This portal is fed by XML; there is no API mode for it");
    if (mode === "api" && acct.get("lastTestOk") !== true) throw new ConflictError("Test the connection successfully before switching to live API mode");
    await u.repo("PortalAccount").updateById(accountId, { mode }, { transaction: u.tx });
    await u.audit({ action: "portal_account.mode_changed", entityType: "portal_account", entityId: accountId, after: { mode } });
  });
}

export async function rotatePortalFeedToken(sq: Sequelize, ctx: RequestContext, accountId: string) {
  authorize(ctx, "portal.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("PortalAccount").findById(accountId, { transaction: u.tx }))) throw new NotFoundError("Portal account");
    const feedToken = randomBytes(24).toString("base64url");
    await u.repo("PortalAccount").updateById(accountId, { feedToken }, { transaction: u.tx });
    await u.audit({ action: "portal_account.feed_token_rotated", entityType: "portal_account", entityId: accountId });
    return { feedToken, feedUrl: baseUrlOf() ? `${baseUrlOf()}/api/v1/feeds/${feedToken}` : null };
  });
}

/** Portal accounts for the Distribution screen: provider, mode, masked key, feed URL, last connection test, and how many listings are on each. */
export async function portalOverview(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "portal.manage");
  return withUow(sq, ctx, async (u) => {
    const accounts = (await u.repo("PortalAccount").findAll({ order: [["createdAt", "ASC"]], transaction: u.tx })) as any[];
    const counts = await u.sq.query<{ portal_account_id: string; status: string; n: number }>("SELECT portal_account_id, last_status AS status, COUNT(*) AS n FROM listing_channels WHERE tenant_id=:t AND channel_kind='portal' AND enabled=1 GROUP BY portal_account_id, last_status", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    return {
      providers: listPortalProviders(), baseUrlConfigured: !!baseUrlOf(),
      accounts: accounts.map((a) => {
        const creds = readCreds(a);
        return {
          id: a.get("id"), provider: a.get("provider"), name: a.get("name"), mode: a.get("mode"), status: a.get("status"), hasCredentials: !!creds, apiKeyMasked: creds ? maskKey(creds.apiKey) : null, baseUrl: creds?.baseUrl ?? null,
          feedUrl: feedUrlFor(a), lastTestedAt: a.get("lastTestedAt"), lastTestOk: a.get("lastTestOk"), lastTestMessage: a.get("lastTestMessage"),
          listings: counts.filter((c) => c.portal_account_id === a.get("id")).reduce((acc, c) => ({ ...acc, [c.status ?? "pending"]: Number(c.n) }), {} as Record<string, number>),
        };
      }),
    };
  });
}

// ------------------------------------------------------------------ Property Finder Enterprise API client (unverified contract)
const clip = (s: string) => s.replace(/\s+/g, " ").slice(0, 300);

/**
 * Property Finder Enterprise API client. The contract is issued privately to partner agencies, so paths and payload names here are the commonly used shape
 * and are configurable (credentials.tokenPath / listingsPath / locationsPath). "Test connection" proves the credentials; the first real publish should be
 * checked against Property Finder's documentation. Failures keep the portal's own error text so support can see exactly what it rejected.
 */
export class PropertyFinderClient {
  private tokenCache: { token: string; until: number } | null = null;
  constructor(private readonly c: PortalCredentials, private readonly http: typeof fetch = fetch) {}
  private url(path: string) { return `${this.c.baseUrl}${path.startsWith("/") ? path : `/${path}`}`; }

  async token(): Promise<string> {
    if (this.tokenCache && this.tokenCache.until > Date.now() + 30_000) return this.tokenCache.token;
    const r = await this.http(this.url(this.c.tokenPath ?? "/auth/token"), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ apiKey: this.c.apiKey, apiSecret: this.c.apiSecret }), signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    if (!r.ok) throw new PortalApiError(`Authentication failed (${r.status}): ${clip(text)}`, r.status);
    let j: any; try { j = JSON.parse(text); } catch { throw new PortalApiError("Authentication returned something that is not JSON", r.status); }
    const token = j.accessToken ?? j.access_token ?? j.token;
    if (!token) throw new PortalApiError("Authentication succeeded but no access token was returned", r.status);
    this.tokenCache = { token, until: Date.now() + Number(j.expiresIn ?? j.expires_in ?? 3000) * 1000 };
    return token;
  }

  private async call(method: string, path: string, body?: unknown) {
    const r = await this.http(this.url(path), { method, headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json", accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    if (!r.ok) throw new PortalApiError(`Portal rejected the request (${r.status}): ${clip(text)}`, r.status);
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }

  async resolveLocation(snapshot: CanonicalListing): Promise<string | number | null> {
    const key = snapshot.location.community ?? snapshot.location.city ?? "";
    const mapped = this.c.locationMap?.[key] ?? this.c.locationMap?.[key.toLowerCase()];
    if (mapped !== undefined) return mapped;
    if (!key) return null;
    const res = await this.call("GET", `${this.c.locationsPath ?? "/locations"}?search=${encodeURIComponent([snapshot.location.building, key].filter(Boolean).join(" "))}`);
    const first = (res.data ?? res.results ?? res)?.[0];
    return first?.id ?? null;
  }

  payload(s: CanonicalListing, locationId: string | number | null) {
    const d = s.details;
    const sale = s.purpose === "sale";
    return {
      reference: s.reference, category: ["office", "retail"].includes(s.property.type) ? "commercial" : "residential", type: s.property.type,
      price: { type: sale ? "sale" : "rent", period: sale ? undefined : d?.rentFrequency ?? "yearly", amounts: sale ? { sale: s.price } : { [d?.rentFrequency ?? "yearly"]: s.price } },
      bedrooms: s.property.bedrooms, bathrooms: s.property.bathrooms, size: s.property.areaSqft, parkingSlots: d?.parkingSpaces ?? undefined, furnishingType: d?.furnishing ?? undefined,
      location: locationId === null ? undefined : { id: locationId }, title: { en: s.title, ar: d?.titleAr ?? undefined }, description: { en: s.description, ar: d?.descriptionAr ?? undefined },
      amenities: d?.features ?? [], compliance: s.permit ? { listingAdvertisementNumber: s.permit.number } : undefined, projectStatus: s.location.offPlan ? "off_plan" : "completed",
      media: { images: s.media.filter((m) => m.kind === "image" && m.url).map((m) => ({ original: { url: m.url } })), videos: d?.videoUrl ? { default: d.videoUrl } : undefined, floorPlans: s.media.filter((m) => m.kind === "floorplan" && m.url).map((m) => ({ original: { url: m.url } })) },
      geo: d?.latitude != null && d?.longitude != null ? { lat: d.latitude, lng: d.longitude } : undefined,
    };
  }

  async push(s: CanonicalListing, action: PortalAction, externalId: string | null): Promise<{ externalId: string | null; url: string | null }> {
    const base = this.c.listingsPath ?? "/listings";
    if (action === "unpublish") {
      if (!externalId) return { externalId: null, url: null };
      await this.call("POST", `${base}/${encodeURIComponent(externalId)}/unpublish`);
      return { externalId, url: null };
    }
    const loc = await this.resolveLocation(s);
    if (loc === null) throw new PortalApiError(`No Property Finder location found for "${s.location.community ?? s.location.city ?? "this listing"}". Add it to the location map in the credentials.`, 422);
    const body = this.payload(s, loc);
    const res = externalId ? await this.call("PUT", `${base}/${encodeURIComponent(externalId)}`, body) : await this.call("POST", base, body);
    const id = String(res.id ?? res.data?.id ?? externalId ?? "");
    if (!id) throw new PortalApiError("The portal accepted the listing but returned no id", 502);
    await this.call("POST", `${base}/${encodeURIComponent(id)}/publish`);
    return { externalId: id, url: res.url ?? res.data?.url ?? null };
  }
}
export class PortalApiError extends Error { constructor(message: string, public status: number) { super(message); this.name = "PortalApiError"; } }

/** Prove the credentials work (gets a token; nothing is created or changed on the portal). Stores the outcome so the screen can show it. */
export async function testPortalConnection(sq: Sequelize, ctx: RequestContext, accountId: string, http: typeof fetch = fetch) {
  authorize(ctx, "portal.manage");
  const acct: any = await withUow(sq, ctx, (u) => u.repo("PortalAccount").findById(accountId, { transaction: u.tx }));
  if (!acct) throw new NotFoundError("Portal account");
  let ok = false, message = "";
  if (acct.get("provider") !== "property_finder") {
    const feed = feedUrlFor(acct);
    ok = !!feed; message = feed ? "This portal pulls your XML feed. Give it the feed URL and ask it to start importing." : "Set PUBLIC_BASE_URL (your site's public address) so the feed URL can be built.";
  } else {
    const creds = readCreds(acct);
    if (!creds) { message = "Add the API credentials first."; }
    else {
      try { await new PropertyFinderClient(creds, http).token(); ok = true; message = "Connected: the portal accepted the credentials."; }
      catch (e) { message = e instanceof Error ? e.message : "Connection failed"; }
    }
  }
  await withUow(sq, ctx, async (u) => {
    await u.repo("PortalAccount").updateById(accountId, { lastTestedAt: new Date(), lastTestOk: ok, lastTestMessage: message.slice(0, 300) }, { transaction: u.tx });
    await u.audit({ action: "portal_account.tested", entityType: "portal_account", entityId: accountId, after: { ok } });
  });
  return { ok, message };
}

// ------------------------------------------------------------------ channels per listing
export async function getListingChannels(sq: Sequelize, ctx: RequestContext, listingId: string) {
  return withUow(sq, ctx, async (u) => {
    const [accounts, rows] = await Promise.all([u.repo("PortalAccount").findAll({ where: { status: "active" }, transaction: u.tx }), u.repo("ListingChannel").findAll({ where: { listingId }, transaction: u.tx })]);
    const listing: any = await u.repo("Listing").findById(listingId, { transaction: u.tx });
    const find = (kind: string, acct?: string) => (rows as any[]).find((r) => r.get("channelKind") === kind && (r.get("portalAccountId") ?? null) === (acct ?? null));
    return [
      { kind: "website", portalAccountId: null, label: "Property website", enabled: find("website")?.get("enabled") ?? !!listing?.get("shareEnabled"), status: listing?.get("shareEnabled") ? "live" : "off", externalUrl: null, error: null, lastSyncedAt: null, externalId: null },
      ...(accounts as any[]).map((a) => {
        const r = find("portal", a.get("id"));
        return { kind: "portal", portalAccountId: a.get("id"), label: a.get("name"), provider: a.get("provider"), mode: a.get("mode"), enabled: r ? !!r.get("enabled") : true, status: r?.get("lastStatus") ?? "pending", externalUrl: r?.get("externalUrl") ?? null, error: r?.get("lastError") ?? null, lastSyncedAt: r?.get("lastSyncedAt") ?? null, externalId: r?.get("externalId") ?? null };
      }),
    ];
  });
}

/** Choose which portals a listing goes to. The website switch is handled by the listing's public link; a disabled portal is skipped on the next publish. */
export async function setListingChannel(sq: Sequelize, ctx: RequestContext, listingId: string, portalAccountId: string, enabled: boolean) {
  if (!hasPermission(ctx, "listing.publish")) throw new ConflictError("Missing permission: listing.publish");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Listing").findById(listingId, { transaction: u.tx }))) throw new NotFoundError("Listing");
    if (!(await u.repo("PortalAccount").findById(portalAccountId, { transaction: u.tx }))) throw new NotFoundError("Portal account");
    const row: any = await u.repo("ListingChannel").findOne({ where: { listingId, channelKind: "portal", portalAccountId }, transaction: u.tx });
    if (row) await u.repo("ListingChannel").updateById(row.get("id"), { enabled }, { transaction: u.tx });
    else await u.repo("ListingChannel").create({ id: randomUUID(), listingId, channelKind: "portal", portalAccountId, enabled, attempts: 0 }, { transaction: u.tx });
    await u.audit({ action: enabled ? "listing.channel_enabled" : "listing.channel_disabled", entityType: "listing", entityId: listingId, after: { portalAccountId } });
  });
}

/** Called by publish: is this listing allowed on this portal account? (No row means yes.) */
export async function channelAllowed(u: Uow, listingId: string, portalAccountId: string) {
  const r: any = await u.repo("ListingChannel").findOne({ where: { listingId, channelKind: "portal", portalAccountId }, transaction: u.tx });
  return r ? !!r.get("enabled") : true;
}

export async function recordChannelResult(u: Uow, listingId: string, portalAccountId: string, r: { status: string; error?: string | null; externalId?: string | null; externalUrl?: string | null; pendingPublicationId?: string | null }) {
  const row: any = await u.repo("ListingChannel").findOne({ where: { listingId, channelKind: "portal", portalAccountId }, transaction: u.tx });
  const patch = { lastStatus: r.status, lastError: r.error?.slice(0, 500) ?? null, lastSyncedAt: new Date(), ...(r.externalId ? { externalId: r.externalId } : {}), ...(r.externalUrl ? { externalUrl: r.externalUrl } : {}), ...(r.pendingPublicationId !== undefined ? { pendingPublicationId: r.pendingPublicationId } : {}), attempts: r.status === "failed" || r.status === "retry" ? Number(row?.get("attempts") ?? 0) + 1 : 0 };
  if (row) await u.repo("ListingChannel").updateById(row.get("id"), patch, { transaction: u.tx });
  else await u.repo("ListingChannel").create({ id: randomUUID(), listingId, channelKind: "portal", portalAccountId, enabled: true, ...patch }, { transaction: u.tx });
}

// ------------------------------------------------------------------ delivery of API publications (outside the publish transaction)
/**
 * API-mode publishing never talks to the portal inside the publish transaction. The immutable publication row records what we intend to send, and the
 * listing's channel is marked queued; this worker then delivers after commit, so slow or failing portals never block or roll back a listing change.
 * Failures keep the portal's own error text and retry with backoff (1, 2, 4, 8 minutes, then give up after 5 attempts).
 */
export async function deliverQueuedPublications(sq: Sequelize, ctx: RequestContext, http: typeof fetch = fetch, limit = 25, now = new Date()) {
  const out = { sent: 0, failed: 0 };
  const due = await withUow(sq, ctx, async (u) => {
    const rows = (await u.repo("ListingChannel").findAll({ where: { channelKind: "portal", lastStatus: { [Op.in]: ["queued", "retry"] }, attempts: { [Op.lt]: 5 } }, order: [["updatedAt", "ASC"]], limit: limit * 2, transaction: u.tx })) as any[];
    return rows.filter((r) => !r.get("lastSyncedAt") || new Date(r.get("lastSyncedAt")).getTime() + 60_000 * 2 ** Math.max(0, Number(r.get("attempts")) - 1) <= now.getTime()).slice(0, limit);
  });
  for (const ch of due) {
    const accountId = ch.get("portalAccountId") as string, listingId = ch.get("listingId") as string;
    try {
      const { creds, pub } = await withUow(sq, ctx, async (u) => ({
        creds: readCreds(await u.repo("PortalAccount").findById(accountId, { transaction: u.tx })),
        pub: (await u.repo("PortalPublication").findById(ch.get("pendingPublicationId"), { transaction: u.tx })) as any,
      }));
      if (!creds) throw new PortalApiError("No credentials saved for this portal account", 0);
      if (!pub) throw new PortalApiError("The queued publication no longer exists", 0);
      const snapshot = (typeof pub.get("snapshot") === "string" ? JSON.parse(pub.get("snapshot")) : pub.get("snapshot")) as CanonicalListing;
      const res = await new PropertyFinderClient(creds, http).push(snapshot, pub.get("action"), ch.get("externalId") ?? null);
      await withUow(sq, ctx, async (u) => {
        await recordChannelResult(u, listingId, accountId, { status: pub.get("action") === "unpublish" ? "removed" : "live", externalId: res.externalId, externalUrl: res.url });
        await u.repo("PortalSyncLog").create({ id: randomUUID(), portalAccountId: accountId, listingId, action: pub.get("action"), outcome: "sent", detail: null, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
      });
      out.sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Delivery failed";
      const retriable = e instanceof PortalApiError && (e.status >= 500 || e.status === 429 || e.status === 408);
      logger.warn({ err: e, listingId, accountId }, "portal delivery failed");
      await withUow(sq, ctx, async (u) => {
        await recordChannelResult(u, listingId, accountId, { status: retriable ? "retry" : "failed", error: msg });
        await u.repo("PortalSyncLog").create({ id: randomUUID(), portalAccountId: accountId, listingId, action: "deliver", outcome: "failed", detail: msg.slice(0, 500), createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
      });
      out.failed++;
    }
  }
  return out;
}

// ------------------------------------------------------------------ public feed (portals pull this)
/** The XML a portal fetches from its private feed URL: every published listing whose channel is on for that account, built fresh from the current data. */
export async function buildFeedByToken(sq: Sequelize, token: string): Promise<{ contentType: string; body: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(token)) return null;
  const [row] = await sq.query<{ id: string; tenant_id: string; provider: string }>("SELECT id, tenant_id, provider FROM portal_accounts WHERE feed_token=:t AND status='active'", { replacements: { t: token }, type: QueryTypes.SELECT });
  if (!row) return null;
  const provider = getPortalProvider(row.provider);
  if (!provider?.wrapFeed) return null;
  const ctx = systemContext(row.tenant_id, `corr_feed_${randomUUID()}`);
  const items = await withUow(sq, ctx, async (u) => {
    const listings = (await u.repo("Listing").findAll({ where: { status: "published" }, order: [["publishedAt", "DESC"]], limit: 5000, transaction: u.tx })) as any[];
    const off = new Set(((await u.repo("ListingChannel").findAll({ where: { channelKind: "portal", portalAccountId: row.id, enabled: false }, transaction: u.tx })) as any[]).map((c) => c.get("listingId")));
    const out: string[] = [];
    for (const l of listings) { if (off.has(l.get("id"))) continue; out.push(provider.transform(await buildCanonicalListing(u, l), "publish").payload); }
    return out;
  });
  return provider.wrapFeed(items, { generatedAt: new Date().toISOString() });
}

void Op; void plain;
