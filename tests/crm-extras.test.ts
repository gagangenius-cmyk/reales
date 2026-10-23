import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  countMyUnread, createCommissionPlan, createDeal, createListing, createPartner, createReservation, createRoutingRule, createSavedSearch, createUnit, estimateFromComps, ingestLead,
  listMyNotifications, listReferrals, markAllRead, markNotificationRead, markReferralPaid, matchesForLead, matchesForListing, matchSweep, referLead, rank, runSavedSearch, scoreMatch,
  settleDueReferrals, settleReferral, setMatchStatus, valuateUnit, voidReferral, type Candidate, type Comp,
} from "@reales/domain";
import { systemContext } from "@reales/database";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { makeInventory, makeOrg, agentIn } from "./brokerage-helpers";
import { acceptedOffer, kit, phone, walkTo } from "./deal-helpers";

afterAll(closeTestDb);
const sq = () => testDb();

const cand = (o: Partial<Candidate> = {}): Candidate => ({ listingId: "l1", title: "x", purpose: "sale", price: 2_000_000, currency: "AED", bedrooms: 2, type: "apartment", community: "Marina", unitNumber: "1", areaSqft: 1000, ...o });

describe("match scoring", () => {
  it("scores budget, bedrooms and area, and excludes hard mismatches", () => {
    const c = { purpose: "sale" as const, maxPrice: 2_500_000, bedrooms: 2, communities: ["marina"] };
    expect(scoreMatch(c, cand())).toMatchObject({ score: 100 });
    expect(scoreMatch(c, cand({ bedrooms: 3 }))!.score).toBe(85);
    expect(scoreMatch(c, cand({ price: 2_700_000 }))!.score).toBe(80); // above budget but within 10%
    expect(scoreMatch(c, cand({ price: 2_900_000 }))).toBeNull(); // far above budget
    expect(scoreMatch(c, cand({ purpose: "rent" }))).toBeNull();
    expect(scoreMatch({ ...c, types: ["villa"] }, cand())).toBeNull();
    expect(scoreMatch(c, cand({ community: "Downtown" }))!.score).toBe(70);
    expect(scoreMatch({}, cand())!.score).toBe(50);
    expect(rank(c, [cand({ listingId: "a", bedrooms: 3 }), cand({ listingId: "b" })], 50, 5).map((x) => x.l.listingId)).toEqual(["b", "a"]);
  });
});

async function market() {
  const t = await makeTenant();
  const org = await makeOrg(t);
  const agent = await agentIn(t, org.marina.id, org.bu.id);
  const other = await agentIn(t, org.marina.id, org.bu.id);
  const mgr = await agentIn(t, org.marina.id, org.bu.id, "branch_manager");
  await createRoutingRule(sq(), t.admin, { name: "all to agent", conditions: {}, target: { userIds: [agent.id] } });
  const inv = await makeInventory(t);
  let n = 0;
  const list = async (o: { beds: number; price: number; purpose?: "sale" | "rent"; area?: number }) => {
    const unit = await createUnit(sq(), t.admin, { buildingId: inv.building.id, unitNumber: `${100 + ++n}`, type: "apartment", bedrooms: o.beds, bathrooms: 2, areaSqft: o.area ?? 1000, listPrice: o.price });
    const l: any = await createListing(sq(), t.admin, { unitId: unit.id, purpose: o.purpose ?? "sale", title: `Unit ${n}`, description: "Nice flat", price: o.price, agentUserId: t.adminId });
    await sq().query("UPDATE listings SET status='published', published_at=NOW(3) WHERE id=:id", { replacements: { id: l.id } });
    return { unit, listing: l };
  };
  return { t, org, agent, other, mgr, inv, list };
}
const newLead = (t: Awaited<ReturnType<typeof market>>["t"], extra: Record<string, unknown> = {}) =>
  ingestLead(sq(), t.tenantId, { contact: { firstName: uniq("Buyer"), phone: phone() }, purpose: "buy", sourceCode: "website", budgetMax: 2_500_000, bedrooms: 2, preferredAreas: ["Marina"], ...extra } as any);

describe("matching, alerts and notifications", () => {
  it("ranks published listings for a lead, hides dismissed ones, and respects visibility", async () => {
    const m = await market();
    const best = await m.list({ beds: 2, price: 2_200_000 });
    const near = await m.list({ beds: 3, price: 2_300_000 });
    await m.list({ beds: 2, price: 3_900_000 }); // far above budget
    await m.list({ beds: 2, price: 9_000, purpose: "rent" });
    const lead = await newLead(m.t);
    const res = await matchesForLead(sq(), m.agent.ctx, lead.lead.id);
    expect(res.map((r) => r.listingId)).toEqual([best.listing.id, near.listing.id]);
    expect(res[0]).toMatchObject({ score: 100 });
    await setMatchStatus(sq(), m.agent.ctx, lead.lead.id, near.listing.id, "dismissed");
    expect((await matchesForLead(sq(), m.agent.ctx, lead.lead.id)).map((r) => r.listingId)).toEqual([best.listing.id]);
    await expect(matchesForLead(sq(), m.other.ctx, lead.lead.id)).rejects.toThrow(/not found/i);
    const reverse = await matchesForListing(sq(), m.mgr.ctx, best.listing.id);
    expect(reverse.leads.map((l) => l.leadId)).toContain(lead.lead.id);
  });

  it("alerts the agent once per strong match, and notifications are private and markable", async () => {
    const m = await market();
    const best = await m.list({ beds: 2, price: 2_200_000 });
    await m.list({ beds: 3, price: 2_300_000 }); // 85: also strong
    const lead = await newLead(m.t);
    const sys = systemContext(m.t.tenantId, "corr_sweep_test");
    const first = await matchSweep(sq(), sys);
    expect(first.leadAlerts).toBe(2);
    expect((await matchSweep(sq(), sys)).leadAlerts).toBe(0); // idempotent
    const mine = (await listMyNotifications(sq(), m.agent.ctx)).filter((n: any) => n.kind === "match.new"); // new leads also notify their agent ("lead.assigned")
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ kind: "match.new", entityType: "lead", entityId: lead.lead.id });
    expect(await countMyUnread(sq(), m.agent.ctx)).toBe(3); // two match alerts and the "lead assigned" notice
    expect(await listMyNotifications(sq(), m.other.ctx)).toHaveLength(0);
    await expect(markNotificationRead(sq(), m.other.ctx, mine[0]!.id)).rejects.toThrow(/not found/i);
    await markNotificationRead(sq(), m.agent.ctx, mine[0]!.id);
    expect(await countMyUnread(sq(), m.agent.ctx)).toBe(2);
    expect(await markAllRead(sq(), m.agent.ctx)).toBe(2);
    expect(await countMyUnread(sq(), m.agent.ctx)).toBe(0);
    void best;
  });

  it("saved searches return matches and alert once for listings published after they were created", async () => {
    const m = await market();
    await m.list({ beds: 1, price: 900_000 });
    const s: any = await createSavedSearch(sq(), m.agent.ctx, { name: "1BR under 1M", criteria: { purpose: "sale", maxPrice: 1_000_000, bedrooms: 1, communities: ["Marina"] } });
    expect((await runSavedSearch(sq(), m.agent.ctx, s.id)).length).toBe(1);
    await expect(runSavedSearch(sq(), m.other.ctx, s.id)).rejects.toThrow(/not found/i);
    await expect(createSavedSearch(sq(), m.agent.ctx, { name: "bad", criteria: { minPrice: 5, maxPrice: 1 } })).rejects.toThrow(/exceeds/);
    const sys = systemContext(m.t.tenantId, "corr_sweep_test2");
    await sq().query("UPDATE saved_searches SET last_run_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id=:id", { replacements: { id: s.id } });
    const fresh = await m.list({ beds: 1, price: 950_000 });
    const a = await matchSweep(sq(), sys);
    expect(a.searchAlerts).toBe(2); // the earlier listing was also published within the last hour in this test
    expect((await matchSweep(sq(), sys)).searchAlerts).toBe(0);
    const notes = await listMyNotifications(sq(), m.agent.ctx);
    expect(notes.some((n) => n.kind === "search.new_listing" && n.entityId === fresh.listing.id)).toBe(true);
    const viewer = await makeUser(m.t, ["viewer"]);
    await expect(createSavedSearch(sq(), viewer.ctx, { name: "x", criteria: {} })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("valuation", () => {
  const comp = (kind: "sold" | "asking", psf: number, i = 0): Comp => ({ kind, ref: `c${i}`, unitNumber: `${i}`, bedrooms: 2, areaSqft: 1000, price: psf * 1000, pricePerSqft: psf, date: "2026-09-01" });
  it("refuses to guess with fewer than three comparables and is explicit about confidence", () => {
    expect(estimateFromComps(1000, [comp("sold", 2000), comp("sold", 2100)])).toMatchObject({ sufficient: false });
    const few = estimateFromComps(1000, [comp("sold", 2000, 1), comp("sold", 2200, 2), comp("sold", 2400, 3)]);
    expect(few).toMatchObject({ sufficient: true, estimate: 2_200_000, low: 2_100_000, high: 2_300_000, confidence: "low" });
    const many = estimateFromComps(1000, Array.from({ length: 8 }, (_, i) => comp("sold", 2000 + i * 10, i)));
    expect(many.confidence).toBe("high");
    const asking = estimateFromComps(1000, [comp("asking", 2000, 1), comp("asking", 2000, 2), comp("asking", 2000, 3)]);
    expect(asking.pricePerSqft).toBe(1900); // 5% haircut on asking prices
  });

  it("values a unit from published comparables in the same community, stores it, and says so when data is thin", async () => {
    const m = await market();
    const subject = await createUnit(sq(), m.t.admin, { buildingId: m.inv.building.id, unitNumber: "SUBJ", type: "apartment", bedrooms: 2, bathrooms: 2, areaSqft: 1200, listPrice: 2_000_000 });
    expect(await valuateUnit(sq(), m.agent.ctx, subject.id)).toMatchObject({ sufficient: false });
    await m.list({ beds: 2, price: 2_000_000 });
    await m.list({ beds: 2, price: 2_200_000 });
    await m.list({ beds: 3, price: 2_400_000 });
    const v: any = await valuateUnit(sq(), m.agent.ctx, subject.id);
    expect(v.sufficient).toBe(true);
    expect(v.comps).toHaveLength(3);
    expect(v.estimate).toBeGreaterThan(2_000_000);
    expect(v.valuationId).toBeTruthy();
    const saved = await sq().query<any>("SELECT confidence FROM valuations WHERE unit_id=:u", { replacements: { u: subject.id }, type: QueryTypes.SELECT });
    expect(saved).toHaveLength(1);
    const viewer = await makeUser(m.t, ["viewer"]);
    await expect(valuateUnit(sq(), viewer.ctx, subject.id)).rejects.toBeInstanceOf(ForbiddenError);
    const foreign = await makeTenant();
    await expect(valuateUnit(sq(), foreign.admin, subject.id)).rejects.toThrow(/not found/i);
  });
});

describe("referrals", () => {
  it("freezes the fee percentage, refuses duplicates, settles from the deal's commission, and pays only with step-up", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await createRoutingRule(sq(), t.admin, { name: "a", conditions: {}, target: { userIds: [k.agent.id] } });
    await createCommissionPlan(sq(), t.admin, { name: "Std", dealType: "sale", ratePct: 2, splits: [{ role: "agent", pct: 100 }] });
    const partner: any = await createPartner(sq(), t.admin, { name: "Gulf Mortgage Brokers", kind: "broker", feePct: 25 });
    const lead = await ingestLead(sq(), t.tenantId, { contact: { firstName: "Ref", phone: phone() }, purpose: "buy", sourceCode: "website" });
    const ref: any = await referLead(sq(), t.admin, { partnerId: partner.id, leadId: lead.lead.id });
    expect(Number(ref.feePct)).toBe(25);
    await expect(referLead(sq(), t.admin, { partnerId: partner.id, leadId: lead.lead.id })).rejects.toThrow(/already has a referral/);
    await sq().query("UPDATE referral_partners SET fee_pct=50 WHERE id=:id", { replacements: { id: partner.id } });
    await expect(settleReferral(sq(), t.admin, ref.id)).rejects.toThrow(/no closed deal/);

    const offer = await acceptedOffer(t, k, { amount: 1_000_000, leadId: lead.lead.id });
    const res = await createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id, depositAmount: 50_000 });
    const deal = await createDeal(sq(), k.mgr.ctx, { reservationId: res.id });
    await walkTo(k, deal.id, "closed");

    const sys = systemContext(t.tenantId, "corr_ref");
    expect(await settleDueReferrals(sq(), sys)).toBe(1);
    expect(await settleDueReferrals(sq(), sys)).toBe(0);
    const [won] = (await listReferrals(sq(), t.admin, { limit: 10, offset: 0 })) as any[];
    expect(won).toMatchObject({ status: "won", dealId: deal.id });
    expect(Number(won.feeAmount)).toBe(5000); // 2% of 1,000,000 = 20,000 commission x the frozen 25%
    const mgrCtx = await contextFor(t.tenantId, k.mgr.id);
    await expect(markReferralPaid(sq(), mgrCtx, won.id)).rejects.toThrow();
    const paid: any = await markReferralPaid(sq(), t.admin, won.id);
    expect(paid.status).toBe("paid");
    await expect(voidReferral(sq(), t.admin, won.id, "oops")).rejects.toThrow(/cannot be voided/);
    const agent = await makeUser(t, ["agent"]);
    await expect(createPartner(sq(), agent.ctx, { name: "x", kind: "broker", feePct: 1 })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
