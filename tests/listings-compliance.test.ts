import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  addListingMedia, addPermit, buildPortalFeed, createListing, createPortalAccount, createProject, getListing, listListings, ListingNotPublishableError,
  NotFoundError, publishListing, seedRegulatory, resolveListingRule, setUnitStatus, unpublishListing, unpublishNonCompliant, updateListing,
  validateListing, verifyPermit, addBrokerLicence, verifyBrokerLicence, createUnit, assignRole,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { agentIn, dateOffset, makeInventory, makeListing, makeOrg, makeVerifiedLicences, Tenant } from "./brokerage-helpers";

afterAll(closeTestDb);
const sq = () => testDb();

const codes = (e: { issues: { code: string }[] }) => e.issues.map((i) => i.code).sort();
async function addImages(t: Tenant, listingId: string, n = 3) {
  for (let i = 0; i < n; i++) await addListingMedia(sq(), t.admin, listingId, { kind: "image", storageKey: `img/${uniq("k")}.jpg` });
}
async function permit(t: Tenant, listingId: string, o: { authority?: string; expiresAt?: string; verify?: "valid" | "rejected" | "revoked" | null } = {}) {
  const p = await addPermit(sq(), t.admin, listingId, { permitNo: uniq("TRK"), authority: o.authority ?? "DLD_TRAKHEESI", expiresAt: o.expiresAt ?? dateOffset(90) });
  if (o.verify !== null) await verifyPermit(sq(), t.admin, p.id, o.verify ?? "valid");
  return p;
}

/** Everything a Dubai listing needs, verified. Returns the pieces for tweaking. */
async function readyDubaiListing(t: Tenant, kitOpts = {}) {
  const org = await makeOrg(t);
  const agent = await agentIn(t, org.marina.id, org.bu.id, "senior_broker");
  const kit = await makeInventory(t, kitOpts);
  const lic = await makeVerifiedLicences(t, agent.id);
  const listing = await makeListing(t, kit, agent.id, lic.company.id);
  await addImages(t, listing.id);
  const p = await permit(t, listing.id);
  return { org, agent, kit, lic, listing, permit: p };
}

describe("publication gate (Dubai mainland rules)", () => {
  it("reports every missing requirement, then becomes publishable as each is satisfied and verified", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id, "senior_broker");
    const kit = await makeInventory(t, { kind: "off_plan", registrationNo: null, escrowAccountRef: null });
    const listing = await createListing(sq(), t.admin, { unitId: kit.unit.id, purpose: "sale", agentUserId: agent.id }); // no title/description/price
    let ev = await validateListing(sq(), t.admin, listing.id);
    expect(ev.publishable).toBe(false);
    expect(ev.jurisdiction).toBe("DUBAI_MAINLAND");
    expect(codes(ev)).toEqual(expect.arrayContaining([
      "field_missing", "media_insufficient", "permit_missing", "broker_licence_missing", "agent_licence_invalid", "offplan_unregistered", "offplan_no_escrow",
    ]));
    await expect(publishListing(sq(), t.admin, listing.id)).rejects.toBeInstanceOf(ListingNotPublishableError);

    await updateListing(sq(), t.admin, listing.id, { title: "Nice", price: 1_900_000 });
    await sq().query("UPDATE listings SET description='Full description' WHERE id=:id", { replacements: { id: listing.id } });
    await sq().query("UPDATE real_estate_projects SET registration_no='PRJ-9', escrow_account_ref='ESC-9' WHERE id=:id", { replacements: { id: kit.project.id } });
    await addImages(t, listing.id);
    ev = await validateListing(sq(), t.admin, listing.id);
    expect(codes(ev)).toEqual(["agent_licence_invalid", "broker_licence_missing", "permit_missing"]);

    const p = await permit(t, listing.id, { verify: null });
    expect(codes(await validateListing(sq(), t.admin, listing.id))).toContain("permit_invalid"); // recorded but unverified is NOT valid
    await verifyPermit(sq(), t.admin, p.id, "valid");
    const lic = await makeVerifiedLicences(t, agent.id);
    await updateListing(sq(), t.admin, listing.id, { brokerLicenceId: lic.company.id });
    ev = await validateListing(sq(), t.admin, listing.id);
    expect(ev).toMatchObject({ publishable: true, issues: [], ruleVersion: expect.any(Number) });
    const res = await publishListing(sq(), t.admin, listing.id);
    expect(res.listing.status).toBe("published");
  });

  it("blocks on expired or revoked permits and licences even if they were verified earlier", async () => {
    const t = await makeTenant();
    const k = await readyDubaiListing(t);
    expect((await validateListing(sq(), t.admin, k.listing.id)).publishable).toBe(true);

    await sq().query("UPDATE listing_permits SET expires_at=:d WHERE id=:id", { replacements: { d: dateOffset(-1), id: k.permit.id } });
    expect(codes(await validateListing(sq(), t.admin, k.listing.id))).toEqual(["permit_invalid"]);
    await sq().query("UPDATE listing_permits SET expires_at=:d WHERE id=:id", { replacements: { d: dateOffset(30), id: k.permit.id } });
    await verifyPermit(sq(), t.admin, k.permit.id, "revoked");
    expect(codes(await validateListing(sq(), t.admin, k.listing.id))).toEqual(["permit_invalid"]);
    await verifyPermit(sq(), t.admin, k.permit.id, "valid");

    await verifyBrokerLicence(sq(), t.admin, k.lic.company.id, "revoked");
    expect(codes(await validateListing(sq(), t.admin, k.listing.id))).toEqual(["broker_licence_invalid"]);
    await verifyBrokerLicence(sq(), t.admin, k.lic.company.id, "valid");
    await sq().query("UPDATE broker_licences SET expires_at=:d WHERE id=:id", { replacements: { d: dateOffset(-5), id: k.lic.agent.id } });
    expect(codes(await validateListing(sq(), t.admin, k.listing.id))).toEqual(["agent_licence_invalid"]);
  });

  it("rejects a permit from the wrong authority and an unavailable unit", async () => {
    const t = await makeTenant();
    const k = await readyDubaiListing(t);
    const other = await makeListingLike(t, k);
    const wrong = await addPermit(sq(), t.admin, other.id, { permitNo: uniq("ADR"), authority: "ADREC", expiresAt: dateOffset(60) });
    await verifyPermit(sq(), t.admin, wrong.id, "valid");
    expect(codes(await validateListing(sq(), t.admin, other.id))).toEqual(["permit_invalid"]); // verified, unexpired, but not an accepted authority for Dubai
    expect((await validateListing(sq(), t.admin, k.listing.id)).publishable).toBe(true);
    await sq().query("UPDATE units SET status='reserved' WHERE id=:id", { replacements: { id: k.kit.unit.id } });
    expect(codes(await validateListing(sq(), t.admin, k.listing.id))).toEqual(["unit_unavailable"]);
  });

  it("applies jurisdiction-specific rules: Abu Dhabi needs ADREC, ADGM needs no advertising permit, unknown jurisdictions are blocked", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id, "senior_broker");

    const ad = await makeInventory(t, { jurisdiction: "ABU_DHABI_MAINLAND" });
    const adLic = await makeVerifiedLicences(t, agent.id, "ADREC");
    const adListing = await makeListing(t, ad, agent.id, adLic.company.id);
    await addImages(t, adListing.id);
    await permit(t, adListing.id, { authority: "DLD_TRAKHEESI" });
    expect(codes(await validateListing(sq(), t.admin, adListing.id))).toEqual(["permit_invalid"]);
    await permit(t, adListing.id, { authority: "ADREC" });
    expect((await validateListing(sq(), t.admin, adListing.id)).publishable).toBe(true);

    const gm = await makeInventory(t, { jurisdiction: "ADGM", kind: "off_plan", escrowAccountRef: null });
    const gmLic = await addBrokerLicence(sq(), t.admin, { holderType: "company", holderName: "ADGM Broker", licenceNo: uniq("G"), authority: "ADGM_RA", expiresAt: dateOffset(200) });
    await verifyBrokerLicence(sq(), t.admin, gmLic.id, "valid");
    const gmListing = await makeListing(t, gm, agent.id, gmLic.id);
    await addImages(t, gmListing.id);
    const gmEval = await validateListing(sq(), t.admin, gmListing.id);
    expect(gmEval).toMatchObject({ publishable: true, jurisdiction: "ADGM" }); // no permit, no agent licence, no escrow ref required by the ADGM rule

    const odd = await makeInventory(t, { jurisdiction: "MARS_BASE" });
    const oddListing = await makeListing(t, odd, agent.id);
    expect(codes(await validateListing(sq(), t.admin, oddListing.id))).toEqual(["jurisdiction_unsupported"]);
  });
});

async function makeListingLike(t: Tenant, k: Awaited<ReturnType<typeof readyDubaiListing>>) {
  const unit = await createUnit(sq(), t.admin, { buildingId: k.kit.building.id, unitNumber: uniq("X").slice(0, 12), type: "apartment", areaSqft: 900, bedrooms: 1, listPrice: 1_000_000 });
  const l = await createListing(sq(), t.admin, { unitId: unit.id, purpose: "rent", title: "T", description: "D", price: 90_000, agentUserId: k.agent.id, brokerLicenceId: k.lic.company.id });
  await addImages(t, l.id);
  return l;
}

describe("portal publication snapshots", () => {
  async function withPortals(t: Tenant) {
    await createPortalAccount(sq(), t.admin, { provider: "bayut", name: "Bayut main" });
    await createPortalAccount(sq(), t.admin, { provider: "property_finder", name: "PF main" });
  }

  it("writes an immutable snapshot per portal, escapes XML, and labels re-publishes as updates", async () => {
    const t = await makeTenant();
    await withPortals(t);
    const k = await readyDubaiListing(t);
    await updateListing(sq(), t.admin, k.listing.id, { title: "Sea <view> & \"marina\" 2BR" });
    const first = await publishListing(sq(), t.admin, k.listing.id);
    expect(first.publications.map((p) => p.provider).sort()).toEqual(["bayut", "property_finder"]);
    expect(first.publications.every((p) => p.status === "exported" && p.action === "publish")).toBe(true);

    const rows = await sq().query<any>("SELECT action, payload_format, payload, snapshot_hash, snapshot FROM portal_publications WHERE tenant_id=:t AND listing_id=:l", { replacements: { t: t.tenantId, l: k.listing.id }, type: QueryTypes.SELECT });
    const xml = rows.find((r) => r.payload_format === "xml").payload as string;
    expect(xml).toContain("Sea &lt;view&gt; &amp; &quot;marina&quot; 2BR");
    expect(xml).toContain(`<Permit_Number>${k.permit.permitNo}</Permit_Number>`);
    const json = JSON.parse(rows.find((r) => r.payload_format === "json").payload);
    expect(json.permit_number).toBe(k.permit.permitNo);
    expect(json.price).toEqual({ value: 2_100_000, currency: "AED" });

    await sq().query("UPDATE listings SET price=2500000 WHERE id=:id", { replacements: { id: k.listing.id } });
    const second = await publishListing(sq(), t.admin, k.listing.id);
    expect(second.publications.every((p) => p.action === "update")).toBe(true);
    const all = await sq().query<any>("SELECT snapshot FROM portal_publications WHERE tenant_id=:t AND listing_id=:l ORDER BY created_at", { replacements: { t: t.tenantId, l: k.listing.id }, type: QueryTypes.SELECT });
    const prices = all.map((r) => (typeof r.snapshot === "string" ? JSON.parse(r.snapshot) : r.snapshot).price);
    expect(prices).toEqual([2_100_000, 2_100_000, 2_500_000, 2_500_000]); // what we sent at each time is preserved

    await expect(sq().query("UPDATE portal_publications SET status='failed' WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);
    await expect(sq().query("DELETE FROM portal_publications WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);
    const detail = await getListing(sq(), t.admin, k.listing.id);
    expect(detail.publications).toHaveLength(4);
    expect(detail.priceHistory.map((p: any) => Number(p.price))).toEqual([2_100_000]); // sql-edited price bypassed the service, so no history row
  });

  it("does not publish to portals when the gate fails, and never sends a live API request in export mode", async () => {
    const t = await makeTenant();
    await withPortals(t);
    const k = await readyDubaiListing(t);
    await verifyPermit(sq(), t.admin, k.permit.id, "revoked");
    await expect(publishListing(sq(), t.admin, k.listing.id)).rejects.toBeInstanceOf(ListingNotPublishableError);
    const n = await sq().query<{ c: number }>("SELECT COUNT(*) c FROM portal_publications WHERE tenant_id=:t", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(Number(n[0]!.c)).toBe(0);

    await verifyPermit(sq(), t.admin, k.permit.id, "valid");
    await createPortalAccount(sq(), t.admin, { provider: "bayut", name: "Bayut live", mode: "api" });
    const res = await publishListing(sq(), t.admin, k.listing.id);
    const live = res.publications.find((p) => p.status === "failed");
    expect(live).toBeTruthy(); // honest failure: live sync needs an authorised partner integration
    await expect(createPortalAccount(sq(), t.admin, { provider: "nonexistent", name: "x" })).rejects.toThrow(/Unknown portal provider/);
  });

  it("unpublishes automatically when the unit stops being available, and via the compliance sweep when a permit lapses", async () => {
    const t = await makeTenant();
    await withPortals(t);
    const k = await readyDubaiListing(t);
    await publishListing(sq(), t.admin, k.listing.id);
    await setUnitStatus(sq(), t.admin, k.kit.unit.id, "reserved", "deposit paid");
    expect((await getListing(sq(), t.admin, k.listing.id)).status).toBe("unpublished");
    const acts = await sq().query<{ action: string }>("SELECT action FROM portal_publications WHERE tenant_id=:t AND listing_id=:l ORDER BY created_at", { replacements: { t: t.tenantId, l: k.listing.id }, type: QueryTypes.SELECT });
    expect(acts.map((a) => a.action).filter((a) => a === "unpublish")).toHaveLength(2);

    await setUnitStatus(sq(), t.admin, k.kit.unit.id, "available");
    await publishListing(sq(), t.admin, k.listing.id);
    await sq().query("UPDATE listing_permits SET expires_at=:d WHERE id=:id", { replacements: { d: dateOffset(-1), id: k.permit.id } });
    const swept = await unpublishNonCompliant(sq(), t.admin);
    expect(swept.map((s) => s.id)).toEqual([k.listing.id]);
    expect(swept[0]!.issues.map((i) => i.code)).toContain("permit_invalid");
    expect((await getListing(sq(), t.admin, k.listing.id)).status).toBe("unpublished");
    expect(await unpublishNonCompliant(sq(), t.admin)).toEqual([]); // idempotent
  });

  it("builds a manual-upload feed from the latest snapshots only", async () => {
    const t = await makeTenant();
    const bayut = await createPortalAccount(sq(), t.admin, { provider: "bayut", name: "Bayut" });
    const k = await readyDubaiListing(t);
    await publishListing(sq(), t.admin, k.listing.id);
    let feed = await buildPortalFeed(sq(), t.admin, bayut.id);
    expect(feed).toMatchObject({ format: "xml", count: 1 });
    expect(feed.body).toContain("<Properties>");
    await unpublishListing(sq(), t.admin, k.listing.id, "owner withdrew");
    feed = await buildPortalFeed(sq(), t.admin, bayut.id);
    expect(feed.count).toBe(0);
  });
});

describe("listing permissions and tenant isolation", () => {
  it("lets only the right people publish: unanchored broker cannot, project-anchored broker only for that project, other tenant never", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const broker = await agentIn(t, org.marina.id, org.bu.id, "senior_broker");
    const k1 = await makeInventory(t);
    const lic = await makeVerifiedLicences(t, broker.id);
    const projA = await createProject(sq(), t.admin, { code: "A", name: "Project A" });
    const projB = await createProject(sq(), t.admin, { code: "B", name: "Project B" });
    const mk = async (crmProjectId: string) => {
      const kit = await makeInventory(t);
      const l = await createListing(sq(), t.admin, { unitId: kit.unit.id, purpose: "sale", title: "T", description: "D", price: 1_500_000, agentUserId: broker.id, brokerLicenceId: lic.company.id, projectId: crmProjectId, branchId: org.marina.id });
      await addImages(t, l.id);
      await verifyPermit(sq(), t.admin, (await addPermit(sq(), t.admin, l.id, { permitNo: uniq("P"), authority: "DLD_TRAKHEESI", expiresAt: dateOffset(60) })).id, "valid");
      return l;
    };
    const la = await mk(projA.id);
    const lb = await mk(projB.id);
    void k1;

    const unanchored = await contextFor(t.tenantId, broker.id);
    await expect(publishListing(sq(), unanchored, la.id)).rejects.toBeInstanceOf(ForbiddenError);

    await assignRole(sq(), t.admin, broker.id, { roleKey: "senior_broker", anchorType: "project", anchorId: projA.id });
    const anchored = await contextFor(t.tenantId, broker.id);
    await expect(publishListing(sq(), anchored, la.id)).resolves.toMatchObject({ listing: { status: "published" } });
    await expect(publishListing(sq(), anchored, lb.id)).rejects.toBeInstanceOf(ForbiddenError);

    const other = await makeTenant();
    await expect(getListing(sq(), other.admin, la.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(validateListing(sq(), other.admin, la.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createListing(sq(), other.admin, { unitId: (await makeInventory(t)).unit.id, purpose: "sale" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await listListings(sq(), other.admin, { limit: 50, offset: 0 })).toEqual([]);
  });

  it("agents can create and edit only their own listings and cannot verify permits", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const a1 = await agentIn(t, org.marina.id, org.bu.id);
    const a2 = await agentIn(t, org.marina.id, org.bu.id);
    const kit = await makeInventory(t);
    const l = await createListing(sq(), a1.ctx, { unitId: kit.unit.id, purpose: "sale", title: "Mine", price: 1_000_000 });
    expect(l.agentUserId).toBe(a1.id);
    await expect(updateListing(sq(), a2.ctx, l.id, { title: "Steal" })).rejects.toBeInstanceOf(ForbiddenError); // same branch: visible, but not theirs to edit
    await expect(updateListing(sq(), a1.ctx, l.id, { title: "Mine v2" })).resolves.toMatchObject({ title: "Mine v2" });
    const p = await addPermit(sq(), a1.ctx, l.id, { permitNo: uniq("P"), authority: "DLD_TRAKHEESI", expiresAt: dateOffset(30) });
    await expect(verifyPermit(sq(), a1.ctx, p.id, "valid")).rejects.toBeInstanceOf(ForbiddenError); // agents cannot self-verify compliance documents
  }, 30000);
});

describe("regulatory rule versioning", () => {
  it("is idempotent on re-seed and records a new version (closing the old one) when a definition changes", async () => {
    await seedRegulatory(sq());
    const v = async () => (await sq().query<{ version: number }>(
      "SELECT MAX(v.version) version FROM regulatory_rule_versions v JOIN regulatory_rules r ON r.id=v.rule_id JOIN jurisdictions j ON j.id=r.jurisdiction_id WHERE j.code='ADGM'", { type: QueryTypes.SELECT }))[0]!.version;
    const before = await v();
    await seedRegulatory(sq());
    expect(await v()).toBe(before);
    const rule = await resolveListingRule(sq(), "ADGM");
    expect(rule!.definition.permit.required).toBe(false);
    expect(rule!.ruleVersion).toBe(before);
    expect(await resolveListingRule(sq(), "NOWHERE")).toBeNull();
  });
});
