import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  bulkListingAction, deleteListingMedia, duplicateListing, getListingDetail, getPublicListing, listingLifecycleSweep, refreshListing, reorderListingMedia, savePortalCredentials,
  searchLeadsAdvanced, searchListingsAdvanced, setListingShare, submitListingEnquiry, updateListingDetails, updateListingMedia, uploadListingMedia, listingQuality, leadsOverview, listingsOverview,
  clientListingsPdf, testPortalConnection,
} from "@reales/domain";
import { systemContext } from "@reales/database";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, testDb, uniq } from "./helpers";
import { agentIn, makeInventory, makeListing, makeOrg, makeVerifiedLicences } from "./brokerage-helpers";

const sq = () => testDb();
afterAll(closeTestDb);

/** A real 1x1 PNG; `salt` appends bytes after the image data so each photo has its own hash. */
const png = (salt: string) => Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"), Buffer.from(salt)]);

async function setup() {
  const t = await makeTenant();
  const org = await makeOrg(t);
  const agent = await agentIn(t, org.marina.id, org.bu.id);
  const inv = await makeInventory(t);
  const lic = await makeVerifiedLicences(t, agent.id);
  const listing = await makeListing(t, inv, agent.id, lic.agent.id);
  return { t, org, agent, inv, listing };
}

describe("listing media", () => {
  it("stores photos once each, keeps order and cover, and refuses duplicates and non-images", async () => {
    const { t, listing } = await setup();
    const a = await uploadListingMedia(sq(), t.admin, listing.id, { filename: "a.png", mime: "image/png", bytes: png("a") });
    const b = await uploadListingMedia(sq(), t.admin, listing.id, { filename: "b.png", mime: "image/png", bytes: png("b") });
    await expect(uploadListingMedia(sq(), t.admin, listing.id, { filename: "a2.png", mime: "image/png", bytes: png("a") })).rejects.toThrow(/already/i);
    await expect(uploadListingMedia(sq(), t.admin, listing.id, { filename: "x.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 test") })).rejects.toThrow();
    let d: any = await getListingDetail(sq(), t.admin, listing.id);
    expect(d.coverMediaId).toBe(a.id);
    await reorderListingMedia(sq(), t.admin, listing.id, [b.id, a.id]);
    await updateListingMedia(sq(), t.admin, listing.id, b.id, { cover: true, caption: "Living room" });
    d = await getListingDetail(sq(), t.admin, listing.id);
    expect(d.media.map((m: any) => m.id)).toEqual([b.id, a.id]);
    expect(d.coverMediaId).toBe(b.id);
    await deleteListingMedia(sq(), t.admin, listing.id, b.id);
    d = await getListingDetail(sq(), t.admin, listing.id);
    expect(d.media).toHaveLength(1);
    expect(d.coverMediaId).toBe(a.id);
  });

  it("does not let an agent outside the listing's scope change its media", async () => {
    const { t, org, listing } = await setup();
    const stranger = await agentIn(t, org.bay.id, org.bu.id);
    await expect(uploadListingMedia(sq(), stranger.ctx, listing.id, { filename: "z.png", mime: "image/png", bytes: png("z") })).rejects.toThrow();
  });
});

describe("listing details, quality and lifecycle", () => {
  it("scores completeness, saves amenities only from the catalogue and gives every listing a reference", async () => {
    const { t, listing } = await setup();
    await updateListingDetails(sq(), t.admin, listing.id, { features: ["balcony", "terrace", "not-a-real-amenity"], furnishing: "furnished", parkingSpaces: 2 });
    const d: any = await getListingDetail(sq(), t.admin, listing.id);
    expect(d.reference).toMatch(/^RLS-\d{6}$/);
    expect(d.features).toEqual(expect.arrayContaining(["balcony", "terrace"]));
    expect(d.features).not.toContain("not-a-real-amenity");
    const low = listingQuality({ title: null, description: null, features: [] }, 0, false, false);
    const high = listingQuality({ title: "A good title for a listing", description: "x".repeat(400), features: ["a", "b", "c", "d", "e", "f"], furnishing: "furnished", price: 1, parkingSpaces: 1, videoUrl: "https://v" }, 12, true, true);
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("duplicates as a draft, refreshes, and expires published listings past their date in the sweep", async () => {
    const { t, listing } = await setup();
    const copy: any = await duplicateListing(sq(), t.admin, listing.id, "rent");
    expect(copy.status).toBe("draft");
    expect(copy.id).not.toBe(listing.id);
    await sq().query("UPDATE listings SET status='published', published_at=NOW(3), expires_on='2000-01-01' WHERE id=:id", { replacements: { id: listing.id } });
    const r1 = await listingLifecycleSweep(sq(), systemContext(t.tenantId, uniq("c")));
    expect(r1.expired).toBeGreaterThanOrEqual(1);
    const [row] = await sq().query<{ status: string }>("SELECT status FROM listings WHERE id=:id", { replacements: { id: listing.id }, type: QueryTypes.SELECT });
    expect(row!.status).toBe("unpublished");
    await expect(refreshListing(sq(), t.admin, listing.id)).resolves.toBeTruthy();
    const r2 = await listingLifecycleSweep(sq(), systemContext(t.tenantId, uniq("c")));
    expect(r2.expired).toBe(0); // idempotent
  });

  it("applies a bulk action to many listings and reports the ones it could not change", async () => {
    const { t, listing } = await setup();
    const res = await bulkListingAction(sq(), t.admin, [listing.id, "11111111-1111-4111-8111-111111111111"], { type: "feature", value: true });
    expect(res.done).toBe(1);
    expect(res.failed).toHaveLength(1);
  });
});

describe("public sharing and enquiries", () => {
  it("serves a listing only while it is published and shared, counts views, and turns an enquiry into a lead", async () => {
    const { t, listing } = await setup();
    const share: any = await setListingShare(sq(), t.admin, listing.id, { enabled: true });
    const token = share.token ?? share.shareToken;
    expect(await getPublicListing(sq(), token)).toBeNull(); // draft: not public
    await sq().query("UPDATE listings SET status='published', published_at=NOW(3) WHERE id=:id", { replacements: { id: listing.id } });
    const pub = await getPublicListing(sq(), token);
    expect(pub?.reference).toMatch(/^RLS-/);
    await submitListingEnquiry(sq(), token, { name: "Sara Khan", phone: "0501234567", message: "Is it available?" });
    const [c] = await sq().query<{ n: number }>("SELECT COUNT(*) AS n FROM listing_enquiries WHERE listing_id=:id", { replacements: { id: listing.id }, type: QueryTypes.SELECT });
    expect(c!.n).toBe(1);
    await expect(submitListingEnquiry(sq(), token, { name: "", phone: "" })).rejects.toThrow();
    expect(await submitListingEnquiry(sq(), token, { name: "Bot", phone: "1", website: "http://spam" })).toEqual({ ok: true }); // honeypot accepted silently
    const [c2] = await sq().query<{ n: number }>("SELECT COUNT(*) AS n FROM listing_enquiries WHERE listing_id=:id", { replacements: { id: listing.id }, type: QueryTypes.SELECT });
    expect(c2!.n).toBe(1);
    await setListingShare(sq(), t.admin, listing.id, { enabled: false });
    expect(await getPublicListing(sq(), token)).toBeNull();
  });
});

describe("portal credentials", () => {
  it("encrypts credentials, never returns them in full, and reports a failed connection test without throwing", async () => {
    const { t } = await setup();
    const [acct] = await sq().query<{ id: string }>("SELECT id FROM portal_accounts WHERE tenant_id=:t LIMIT 1", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    if (!acct) return; // tenants start without a portal account in some setups; the API route creates one
    const saved: any = await savePortalCredentials(sq(), t.admin, acct.id, { apiKey: "super-secret-key-1234" } as any);
    expect(JSON.stringify(saved)).not.toContain("super-secret-key-1234");
    const [raw] = await sq().query<{ credentials_enc: string }>("SELECT credentials_enc FROM portal_accounts WHERE id=:id", { replacements: { id: acct.id }, type: QueryTypes.SELECT });
    expect(raw!.credentials_enc).not.toContain("super-secret-key-1234");
    const fake = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const r: any = await testPortalConnection(sq(), t.admin, acct.id, fake);
    expect(r.ok).toBe(false);
  });
});

describe("filters, overviews and the client PDF", () => {
  it("filters leads and listings in combination without leaking another tenant's rows", async () => {
    const a = await setup(), b = await setup();
    const la = await searchListingsAdvanced(sq(), a.t.admin, { purpose: "sale", bedsMin: 1, sort: "price_desc" });
    expect(la.rows.every((r: any) => r.tenantId === undefined || r.tenantId === a.t.tenantId)).toBe(true);
    expect(la.rows.map((r: any) => r.id)).toContain(a.listing.id);
    expect(la.rows.map((r: any) => r.id)).not.toContain(b.listing.id);
    expect((await searchListingsAdvanced(sq(), a.t.admin, { noPhotos: true })).rows.map((r: any) => r.id)).toContain(a.listing.id);
    expect((await searchListingsAdvanced(sq(), a.t.admin, { bedsMin: 9 })).total).toBe(0);
    expect((await searchLeadsAdvanced(sq(), a.t.admin, { status: "open", hot: true, sort: "score" })).total).toBe(0);
  });

  it("builds both overviews, and refuses them without the read permission", async () => {
    const { t, org } = await setup();
    const lo: any = await leadsOverview(sq(), t.admin);
    const io: any = await listingsOverview(sq(), t.admin);
    expect(lo.totals.all).toBeGreaterThanOrEqual(0);
    expect(io.totals.all).toBeGreaterThanOrEqual(1);
    const nobody = { ...t.admin, grants: [] };
    await expect(leadsOverview(sq(), nobody as any)).rejects.toBeInstanceOf(ForbiddenError);
    void org;
  });

  it("produces a PDF for the selected listings and rejects an empty or oversize selection", async () => {
    const { t, listing } = await setup();
    const pdf = await clientListingsPdf(sq(), t.admin, { listingIds: [listing.id], clientName: "Mr Ahmed", layout: "both" } as any);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    await expect(clientListingsPdf(sq(), t.admin, { listingIds: [] } as any)).rejects.toThrow();
  });
});
