import { afterAll, describe, expect, it } from "vitest";
import {
  cancelPhotoshoot, cleanFilters, createListing, deleteView, deliverPhotoshoot, listMyNotifications, listPhotoshoots, listViews, requestPhotoshoot, saveView, schedulePhotoshoot, startPhotoshoot,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, makeUser, testDb } from "./helpers";
import { agentIn, makeInventory, makeOrg } from "./brokerage-helpers";

const sq = () => testDb();
afterAll(closeTestDb);

const inDays = (d: number, hour = 10) => new Date(Date.now() + d * 86_400_000 + hour * 3_600_000).toISOString();

async function setup() {
  const t = await makeTenant();
  const org = await makeOrg(t);
  const agent = await agentIn(t, org.marina.id, org.bu.id);
  const photographer = await agentIn(t, org.marina.id, org.bu.id);
  const mgr = await agentIn(t, org.marina.id, org.bu.id, "branch_manager");
  const farMgr = await agentIn(t, org.bay.id, org.bu.id, "branch_manager"); // another branch
  const farAgent = await agentIn(t, org.bay.id, org.bu.id);
  const inv = await makeInventory(t);
  // listed by the Marina manager so the listing belongs to the Marina branch
  const listing = await createListing(sq(), mgr.ctx, { unitId: inv.unit.id, purpose: "sale", title: "Marina 2BR", price: 2_000_000, agentUserId: agent.id });
  return { t, org, agent, photographer, mgr, farMgr, farAgent, listing };
}

describe("photoshoot requests", () => {
  it("lets an agent request once per listing, tells the managers, and hides it from other branches", async () => {
    const { agent, mgr, farMgr, farAgent, listing } = await setup();
    await expect(requestPhotoshoot(sq(), agent.ctx, { listingId: listing.id, shootTypes: [] })).rejects.toThrow(/Choose what/);
    await expect(requestPhotoshoot(sq(), agent.ctx, { listingId: listing.id, shootTypes: ["photos"], preferredDate: "2020-01-01" })).rejects.toThrow(/in the past/);
    await expect(requestPhotoshoot(sq(), farAgent.ctx, { listingId: listing.id, shootTypes: ["photos"] })).rejects.toThrow(/not found/i); // cannot see that listing

    const r: any = await requestPhotoshoot(sq(), agent.ctx, { listingId: listing.id, shootTypes: ["photos", "drone", "photos"], accessNotes: "Concierge has the key" });
    expect(r).toMatchObject({ status: "requested", requestedBy: agent.id });
    expect(r.shootTypes).toEqual(["photos", "drone"]);
    await expect(requestPhotoshoot(sq(), agent.ctx, { listingId: listing.id, shootTypes: ["video"] })).rejects.toThrow(/already has an open/);

    expect((await listMyNotifications(sq(), mgr.ctx)).some((n: any) => n.kind === "photoshoot.requested")).toBe(true);
    expect((await listPhotoshoots(sq(), agent.ctx)).map((x: any) => x.id)).toContain(r.id);
    expect(await listPhotoshoots(sq(), farMgr.ctx)).toHaveLength(0); // manager of another branch
    expect(await listPhotoshoots(sq(), farAgent.ctx)).toHaveLength(0);
    expect((await listPhotoshoots(sq(), mgr.ctx)).map((x: any) => x.id)).toContain(r.id);
    // a role without the request permission cannot ask
    const t2 = await makeTenant();
    const viewer = await makeUser(t2, ["viewer"]);
    await expect(requestPhotoshoot(sq(), viewer.ctx, { listingId: listing.id, shootTypes: ["photos"] })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("runs the workflow: schedule, no double booking, start, deliver, with the right people allowed at each step", async () => {
    const { agent, photographer, mgr, farMgr, listing, t, org } = await setup();
    const r: any = await requestPhotoshoot(sq(), agent.ctx, { listingId: listing.id, shootTypes: ["photos"] });
    await expect(schedulePhotoshoot(sq(), agent.ctx, r.id, { scheduledAt: inDays(2), photographerName: "Studio" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(schedulePhotoshoot(sq(), farMgr.ctx, r.id, { scheduledAt: inDays(2), photographerName: "Studio" })).rejects.toThrow(/not found/i);
    await expect(schedulePhotoshoot(sq(), mgr.ctx, r.id, { scheduledAt: inDays(-1), photographerName: "Studio" })).rejects.toThrow(/past/);
    await expect(schedulePhotoshoot(sq(), mgr.ctx, r.id, { scheduledAt: inDays(2) })).rejects.toThrow(/Name the photographer/);

    const slot = inDays(2, 10);
    const s: any = await schedulePhotoshoot(sq(), mgr.ctx, r.id, { scheduledAt: slot, durationMinutes: 90, photographerUserId: photographer.id });
    expect(s).toMatchObject({ status: "scheduled", durationMinutes: 90, photographerUserId: photographer.id });
    expect((await listMyNotifications(sq(), agent.ctx)).some((n: any) => n.kind === "photoshoot.scheduled")).toBe(true);
    expect((await listMyNotifications(sq(), photographer.ctx)).some((n: any) => n.kind === "photoshoot.scheduled")).toBe(true);

    // a second listing cannot take the photographer at an overlapping time
    const inv2 = await makeInventory(t);
    const listing2 = await createListing(sq(), mgr.ctx, { unitId: inv2.unit.id, purpose: "rent", title: "Another", price: 90_000, agentUserId: agent.id });
    const r2: any = await requestPhotoshoot(sq(), agent.ctx, { listingId: listing2.id, shootTypes: ["video"] });
    const overlapping = new Date(new Date(slot).getTime() + 30 * 60_000).toISOString();
    await expect(schedulePhotoshoot(sq(), mgr.ctx, r2.id, { scheduledAt: overlapping, photographerUserId: photographer.id })).rejects.toThrow(/already booked/);
    const after = new Date(new Date(slot).getTime() + 90 * 60_000).toISOString(); // starts exactly when the first ends
    await expect(schedulePhotoshoot(sq(), mgr.ctx, r2.id, { scheduledAt: after, photographerUserId: photographer.id })).resolves.toMatchObject({ status: "scheduled" });

    // only the photographer or a manager moves it on; delivering needs it started
    const outsider = await agentIn(t, org.marina.id, org.bu.id);
    await expect(startPhotoshoot(sq(), outsider.ctx, r.id)).rejects.toThrow(/not found/i);
    await expect(deliverPhotoshoot(sq(), photographer.ctx, r.id, { mediaCount: 12 })).rejects.toThrow(/Start the photoshoot/);
    await expect(startPhotoshoot(sq(), agent.ctx, r.id)).rejects.toBeInstanceOf(ForbiddenError); // the requester is neither photographer nor manager
    expect(await startPhotoshoot(sq(), photographer.ctx, r.id)).toMatchObject({ status: "in_progress" });
    await expect(startPhotoshoot(sq(), photographer.ctx, r.id)).rejects.toThrow(/Only a scheduled/);
    await expect(deliverPhotoshoot(sq(), photographer.ctx, r.id, { mediaCount: 0 })).rejects.toThrow(/1 to 500/);
    const done: any = await deliverPhotoshoot(sq(), photographer.ctx, r.id, { mediaCount: 24, note: "Edited set uploaded" });
    expect(done).toMatchObject({ status: "delivered", mediaCount: 24, deliveredBy: photographer.id });
    expect((await listMyNotifications(sq(), agent.ctx)).some((n: any) => n.kind === "photoshoot.delivered")).toBe(true);
    await expect(cancelPhotoshoot(sq(), mgr.ctx, r.id, "too late")).rejects.toThrow(/cannot be cancelled/);
    // a delivered shoot frees the listing for a new request
    await expect(requestPhotoshoot(sq(), agent.ctx, { listingId: listing.id, shootTypes: ["video"] })).resolves.toMatchObject({ status: "requested" });
  });

  it("lets the requester cancel only before the shoot starts, and always records a reason", async () => {
    const { agent, photographer, mgr, listing } = await setup();
    const r: any = await requestPhotoshoot(sq(), agent.ctx, { listingId: listing.id, shootTypes: ["photos"] });
    await expect(cancelPhotoshoot(sq(), agent.ctx, r.id, " ")).rejects.toThrow(/reason/);
    await schedulePhotoshoot(sq(), mgr.ctx, r.id, { scheduledAt: inDays(3), photographerUserId: photographer.id });
    await startPhotoshoot(sq(), mgr.ctx, r.id);
    await expect(cancelPhotoshoot(sq(), agent.ctx, r.id, "changed my mind")).rejects.toBeInstanceOf(ForbiddenError); // in progress: managers only
    const c: any = await cancelPhotoshoot(sq(), mgr.ctx, r.id, "Photographer unwell");
    expect(c).toMatchObject({ status: "cancelled", cancelReason: "Photographer unwell", cancelledBy: mgr.id });
    expect((await listMyNotifications(sq(), photographer.ctx)).some((n: any) => n.kind === "photoshoot.cancelled")).toBe(true);
    // requested/scheduled can be cancelled by the requester
    const r2: any = await requestPhotoshoot(sq(), agent.ctx, { listingId: listing.id, shootTypes: ["photos"] });
    expect(await cancelPhotoshoot(sq(), agent.ctx, r2.id, "Not needed")).toMatchObject({ status: "cancelled" });
  });
});

describe("saved views", () => {
  it("keeps views per person, shares only on request, and switches the default", async () => {
    const t = await makeTenant();
    const a = await makeUser(t, ["agent"]);
    const b = await makeUser(t, ["agent"]);
    const mine: any = await saveView(sq(), a.ctx, { entity: "leads", name: "Hot this week", filters: { hot: "1", from: "2026-11-01", page: "3" }, columns: ["Received", "Contact", "Received"] });
    expect(mine).toMatchObject({ name: "Hot this week", shared: false, isDefault: false, columns: ["Received", "Contact"] });
    expect(mine.filters).toEqual({ hot: "1", from: "2026-11-01" }); // page is not part of a view

    expect(await listViews(sq(), b.ctx, "leads")).toHaveLength(0); // private by default
    const shared: any = await saveView(sq(), a.ctx, { entity: "leads", name: "Team: overdue", filters: { followUp: "overdue" }, shared: true });
    const seen: any[] = await listViews(sq(), b.ctx, "leads");
    expect(seen.map((v) => v.id)).toEqual([shared.id]);
    expect(seen[0]).toMatchObject({ mine: false });
    expect(seen[0].owner).toContain("@");
    expect((await listViews(sq(), a.ctx, "listings"))).toHaveLength(0); // per list

    // the person who opens a shared view cannot edit or delete it
    await expect(saveView(sq(), b.ctx, { id: shared.id, entity: "leads", name: "Hijack", filters: {} })).rejects.toThrow(/not found/i);
    await expect(deleteView(sq(), b.ctx, shared.id)).rejects.toThrow(/not found/i);

    // one default per person per list
    const d1: any = await saveView(sq(), a.ctx, { entity: "leads", name: "D1", filters: { status: "open" }, isDefault: true });
    const d2: any = await saveView(sq(), a.ctx, { entity: "leads", name: "D2", filters: { status: "won" }, isDefault: true });
    const defaults = (await listViews(sq(), a.ctx, "leads")).filter((v: any) => v.isDefault).map((v: any) => v.id);
    expect(defaults).toEqual([d2.id]);
    expect(d1.id).not.toBe(d2.id);

    // renaming to an existing name is refused; editing own view works
    await expect(saveView(sq(), a.ctx, { id: d2.id, entity: "leads", name: "D1", filters: {} })).rejects.toThrow(/already have a view/);
    expect(await saveView(sq(), a.ctx, { id: d2.id, entity: "leads", name: "D2 renamed", filters: { status: "lost" } })).toMatchObject({ name: "D2 renamed", filters: { status: "lost" } });
    await deleteView(sq(), a.ctx, d1.id);
    expect((await listViews(sq(), a.ctx, "leads")).map((v: any) => v.id)).not.toContain(d1.id);
  });

  it("needs read access to the list, rejects unsafe filter input, and stays inside the company", async () => {
    const t = await makeTenant();
    const viewer = await makeUser(t, ["viewer"]); // cannot read leads
    await expect(saveView(sq(), viewer.ctx, { entity: "leads", name: "x", filters: {} })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listViews(sq(), viewer.ctx, "leads")).rejects.toBeInstanceOf(ForbiddenError);
    expect(() => cleanFilters({ "bad key!": "1" })).toThrow(/Invalid filter/);
    expect(() => cleanFilters({ q: "x".repeat(201) })).toThrow(/too long/);
    expect(() => cleanFilters({ q: 5 as unknown as string })).toThrow(/Invalid filter/);
    expect(() => cleanFilters(Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, "v"])))).toThrow(/Too many/);

    const a = await makeUser(t, ["agent"]);
    await saveView(sq(), a.ctx, { entity: "listings", name: "Sales", filters: { purpose: "sale" }, shared: true });
    const t2 = await makeTenant();
    const x = await makeUser(t2, ["agent"]);
    expect(await listViews(sq(), x.ctx, "listings")).toHaveLength(0); // another company never sees a shared view
  });
});
