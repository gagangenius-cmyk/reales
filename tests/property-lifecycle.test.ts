import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  archiveListing, assignLead, closeListing, createLead, createListingFromProperty, deliverQueuedEmails, followUpOverdueSweep, getListingDetail, leadStatusSummary, listLocations, listingLifecycleSweep, mockMailer,
  pinsForListings, publishListing, reopenListing, saveLocation, setSettings, updateListingDetails, dailyDigestSweep,
} from "@reales/domain";
import { systemContext } from "@reales/database";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { agentIn, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
beforeEach(() => mockMailer.reset());

const property = (o: Record<string, unknown> = {}) => ({ emirate: "Dubai", community: "Dubai Marina", buildingName: uniq("Tower"), unitNumber: "1204", type: "apartment" as const, purpose: "sale" as const, price: 2_400_000, bedrooms: 2, bathrooms: 3, builtUpAreaSqft: 1200, ...o });

describe("add a listing with its property", () => {
  it("creates the location, building, unit and draft listing, works out price per sqft and reuses what exists", async () => {
    const t = await makeTenant();
    const first: any = await createListingFromProperty(sq(), t.admin, property({ buildingName: "Marina Gate 1", subCommunity: "Marina Promenade", plotAreaSqft: 1500, completionStatus: "ready", ownership: "freehold", yearBuilt: 2018 }));
    expect(first.status).toBe("draft");
    expect(first.pricePerSqft).toBe(2000);
    const d: any = await getListingDetail(sq(), t.admin, first.id);
    expect(d.building.community).toBe("Dubai Marina");
    expect(d.building.subCommunity).toBe("Marina Promenade");
    expect(d.building.country).toBe("AE");
    expect(d.unit.plotAreaSqft).toBe("1500.00");
    expect(d.ownership).toBe("freehold");
    expect(d.completionStatus).toBe("ready");
    // a second unit in the same tower reuses the building
    const second: any = await createListingFromProperty(sq(), t.admin, property({ buildingName: "Marina Gate 1", unitNumber: "1301", subCommunity: "Marina Promenade" }));
    const [n] = await sq().query<{ n: number }>("SELECT COUNT(*) AS n FROM buildings WHERE tenant_id=:t AND name='Marina Gate 1'", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(n!.n).toBe(1);
    expect(second.id).not.toBe(first.id);
    // the same unit and purpose again is refused
    await expect(createListingFromProperty(sq(), t.admin, property({ buildingName: "Marina Gate 1", subCommunity: "Marina Promenade" }))).rejects.toThrow(/live sale listing already exists/);
    // an emirate without listing rules says so instead of guessing a regulator
    await expect(createListingFromProperty(sq(), t.admin, property({ emirate: "Sharjah", community: "Al Majaz" }))).rejects.toThrow(/Listing rules for Sharjah/);
    await expect(createListingFromProperty(sq(), t.admin, property({ builtUpAreaSqft: 0 }))).rejects.toThrow(/built-up area/);
    await expect(createListingFromProperty(sq(), t.admin, property({ bedrooms: undefined }))).rejects.toThrow(/bedrooms/);
  });

  it("offers the UAE location catalogue, lets managers add a missing community, and keeps portal ids behind the portal permission", async () => {
    const t = await makeTenant();
    const agent = await makeUser(t, ["agent"]);
    const all = await listLocations(sq(), t.admin);
    expect(all.some((l: any) => l.emirate === "Dubai" && l.community === "Dubai Marina" && l.latitude)).toBe(true);
    expect(all.some((l: any) => l.emirate === "Abu Dhabi")).toBe(true);
    const added: any = await saveLocation(sq(), agent.ctx, { emirate: "Dubai", community: "Brand New Community" });
    expect(added.community).toBe("Brand New Community");
    await expect(saveLocation(sq(), agent.ctx, { emirate: "Dubai", community: "Brand New Community", bayutId: "123" })).rejects.toBeInstanceOf(ForbiddenError);
    const mapped: any = await saveLocation(sq(), t.admin, { emirate: "Dubai", community: "Brand New Community", bayutId: "123", pfId: "456", latitude: 25.1, longitude: 55.2 });
    expect(mapped.bayutId).toBe("123");
    await expect(saveLocation(sq(), t.admin, { emirate: "Dubai", community: "Brand New Community", latitude: 40, longitude: 10 })).rejects.toThrow(/outside the UAE/);
  });

  it("places map pins: exact when the listing has one, the community centre otherwise", async () => {
    const t = await makeTenant();
    const a: any = await createListingFromProperty(sq(), t.admin, property());
    const b: any = await createListingFromProperty(sq(), t.admin, property({ unitNumber: "9", latitude: 25.0801, longitude: 55.1405 }));
    const pins = await pinsForListings(sq(), t.admin, [a.id, b.id]);
    expect(pins).toHaveLength(2);
    expect(pins.find((p) => p.id === a.id)!.precise).toBe(false);
    expect(pins.find((p) => p.id === b.id)!.precise).toBe(true);
    await updateListingDetails(sq(), t.admin, a.id, { latitude: 25.081, longitude: 55.141 });
    expect((await pinsForListings(sq(), t.admin, [a.id]))[0]!.precise).toBe(true);
  });
});

describe("listing lifecycle", () => {
  it("closes as sold or rented, refuses publishing a closed listing, reopens and archives", async () => {
    const t = await makeTenant();
    const l: any = await createListingFromProperty(sq(), t.admin, property());
    await expect(closeListing(sq(), t.admin, l.id, { outcome: "rented" })).rejects.toThrow(/Only a rental/);
    await expect(archiveListing(sq(), t.admin, l.id)).resolves.toMatchObject({ status: "archived" });
    await expect(publishListing(sq(), t.admin, l.id)).rejects.toThrow(/Reopen/);
    await reopenListing(sq(), t.admin, l.id);
    const closed: any = await closeListing(sq(), t.admin, l.id, { outcome: "sold", note: "Sold to a walk-in buyer" });
    expect(closed.status).toBe("closed");
    expect(closed.closedOutcome).toBe("sold");
    await expect(closeListing(sq(), t.admin, l.id, { outcome: "sold" })).rejects.toThrow(/cannot be closed/);
    // the unit can be listed again once the old listing is closed
    const again: any = await createListingFromProperty(sq(), t.admin, property({ buildingName: (await getListingDetail(sq(), t.admin, l.id) as any).building.name }));
    expect(again.id).not.toBe(l.id);
    await expect(reopenListing(sq(), t.admin, l.id)).rejects.toThrow(/already exists/);
  });

  it("expires published listings only when the company has auto-expire on, and archives old closed ones after the configured days", async () => {
    const t = await makeTenant();
    const sys = () => systemContext(t.tenantId, uniq("c"));
    const l: any = await createListingFromProperty(sq(), t.admin, property());
    await sq().query("UPDATE listings SET status='published', published_at=NOW(3), expires_on='2000-01-01' WHERE id=:id", { replacements: { id: l.id } });
    await setSettings(sq(), t.admin, { "listings.auto_expire": false });
    expect((await listingLifecycleSweep(sq(), sys())).expired).toBe(0);
    await setSettings(sq(), t.admin, { "listings.auto_expire": true });
    expect((await listingLifecycleSweep(sq(), sys())).expired).toBe(1);
    const [row] = await sq().query<{ status: string }>("SELECT status FROM listings WHERE id=:id", { replacements: { id: l.id }, type: QueryTypes.SELECT });
    expect(row!.status).toBe("expired");
    await sq().query("UPDATE listings SET updated_at = DATE_SUB(NOW(3), INTERVAL 200 DAY) WHERE id=:id", { replacements: { id: l.id } });
    expect((await listingLifecycleSweep(sq(), sys())).archived).toBe(1);
    const [row2] = await sq().query<{ status: string; status_before_archive: string }>("SELECT status, status_before_archive FROM listings WHERE id=:id", { replacements: { id: l.id }, type: QueryTypes.SELECT });
    expect(row2).toMatchObject({ status: "archived", status_before_archive: "expired" });
  });
});

describe("lead assignment settings, e-mail notifications and the status summary", () => {
  it("leaves new leads unassigned when automatic assignment is off, and e-mails the agent when assigned if the company wants that", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    await setSettings(sq(), t.admin, { "leads.auto_assign": false });
    const l: any = await createLead(sq(), t.admin, { contact: { firstName: uniq("Lead"), phone: phone() }, purpose: "buy", sourceCode: "walk_in" } as never);
    expect(l.lead.assignedUserId).toBeNull();
    await assignLead(sq(), t.admin, l.lead.id, { userId: agent.id, reason: "Manual" });
    const queued = await sq().query<{ to_email: string; status: string }>("SELECT to_email, status FROM email_queue WHERE tenant_id=:t", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.to_email).toBe(agent.email);
    const sys = systemContext(t.tenantId, uniq("c"));
    expect((await deliverQueuedEmails(sq(), sys)).sent).toBe(1);
    expect(mockMailer.last(agent.email)!.subject).toMatch(/lead was assigned/i);
    expect((await deliverQueuedEmails(sq(), sys)).sent).toBe(0); // sent once
    await setSettings(sq(), t.admin, { "notifications.email.lead_assigned": false });
    const l2: any = await createLead(sq(), t.admin, { contact: { firstName: uniq("Lead"), phone: phone() }, purpose: "buy", sourceCode: "walk_in", assignedUserId: agent.id } as never);
    expect(l2.lead.assignedUserId).toBe(agent.id);
    expect((await sq().query("SELECT id FROM email_queue WHERE tenant_id=:t", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT })).length).toBe(1); // no second e-mail
    // in-app notification still exists
    expect((await sq().query("SELECT id FROM notifications WHERE tenant_id=:t AND user_id=:u", { replacements: { t: t.tenantId, u: agent.id }, type: QueryTypes.SELECT })).length).toBe(2);
  });

  it("reminds once about an overdue follow-up and sends a digest only when switched on", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    const sys = () => systemContext(t.tenantId, uniq("c"));
    const l: any = await createLead(sq(), t.admin, { contact: { firstName: uniq("Lead"), phone: phone() }, purpose: "buy", sourceCode: "walk_in", assignedUserId: agent.id } as never);
    await sq().query("UPDATE leads SET next_follow_up_at = DATE_SUB(NOW(3), INTERVAL 2 HOUR) WHERE id=:id", { replacements: { id: l.lead.id } });
    expect(await followUpOverdueSweep(sq(), sys())).toBe(1);
    expect(await followUpOverdueSweep(sq(), sys())).toBe(0);
    const morning = new Date(`${new Date().toISOString().slice(0, 10)}T05:00:00Z`); // 09:00 Dubai
    expect(await dailyDigestSweep(sq(), sys(), morning)).toBe(0); // off by default
    await setSettings(sq(), t.admin, { "notifications.email.daily_digest": true });
    expect(await dailyDigestSweep(sq(), sys(), morning)).toBeGreaterThan(0);
    expect(await dailyDigestSweep(sq(), sys(), morning)).toBe(0); // once a day
  });

  it("summarises lead status by stage and by what needs action", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    await createLead(sq(), t.admin, { contact: { firstName: uniq("A"), phone: phone() }, purpose: "buy", sourceCode: "walk_in", assignedUserId: agent.id, isHot: true } as never);
    await createLead(sq(), t.admin, { contact: { firstName: uniq("B"), phone: phone() }, purpose: "rent", sourceCode: "walk_in", assignedUserId: agent.id } as never);
    const all: any = await leadStatusSummary(sq(), t.admin);
    expect(all.open).toBe(2);
    expect(all.hot).toBe(1);
    expect(all.stages.reduce((a: number, s: any) => a + s.count, 0)).toBe(2);
    expect(all.today).toBe(2);
    const mine: any = await leadStatusSummary(sq(), agent.ctx);
    expect(mine.open).toBe(2);
    const stranger = await agentIn(t, org.bay.id, org.bu.id);
    expect((await leadStatusSummary(sq(), stranger.ctx) as any).open).toBe(0); // scoped like the lead list
  });
});
