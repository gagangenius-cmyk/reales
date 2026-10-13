import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  acceptOffer, addLeadActivity, advanceDealStage, allocateByPct, approveCommission, cancelDeal, cancelReservation, cancelViewing, checkInViewing, completeMilestone,
  completeViewing, counterOffer, createCommissionPlan, createContact, createDeal, createOffer, createReservation, createRoutingRule, expireOffers, expireReservations,
  getDeal, getLead, getOffer, ingestLead, listCommissions, listDeals, listViewings, NotFoundError, scheduleViewing, setPaymentPlan, DealBlockedError, toMinor, fromMinor,
  rejectOffer, setUnitStatus, createListing, publishListing, addListingMedia, addPermit, verifyPermit,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, testDb, uniq } from "./helpers";
import { agentIn, dateOffset, makeInventory, makeOrg, makeVerifiedLicences, Tenant } from "./brokerage-helpers";
import { acceptedOffer, inHours, kit, openDeal, phone, walkTo } from "./deal-helpers";

afterAll(closeTestDb);
const sq = () => testDb();
describe("viewings", () => {
  it("books, checks in and completes a viewing with feedback, and rejects overlaps, the past and unavailable units", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await createRoutingRule(sq(), t.admin, { name: "a", conditions: {}, target: { userIds: [k.agent.id] } });
    const lead = await ingestLead(sq(), t.tenantId, { contact: { firstName: "Viewer", phone: phone() }, purpose: "buy", sourceCode: "website" });
    const agentCtx = await contextFor(t.tenantId, k.agent.id);
    const start = inHours(24);
    const v = await scheduleViewing(sq(), agentCtx, { leadId: lead.lead.id, unitId: k.inv.unit.id, scheduledAt: start, durationMin: 45 });
    expect(v).toMatchObject({ status: "scheduled", agentUserId: k.agent.id, contactId: lead.lead.contactId });
    const detail = await getLead(sq(), agentCtx, lead.lead.id);
    expect(detail.activities.some((a: any) => a.kind === "viewing")).toBe(true);

    await expect(scheduleViewing(sq(), agentCtx, { leadId: lead.lead.id, scheduledAt: new Date(new Date(start).getTime() + 30 * 60_000).toISOString() })).rejects.toThrow(/already has a viewing/);
    await expect(scheduleViewing(sq(), agentCtx, { leadId: lead.lead.id, scheduledAt: new Date(new Date(start).getTime() + 45 * 60_000).toISOString() })).resolves.toBeTruthy(); // back-to-back is fine
    await expect(scheduleViewing(sq(), agentCtx, { leadId: lead.lead.id, scheduledAt: inHours(-3) })).rejects.toThrow(/past/);
    await sq().query("UPDATE units SET status='sold' WHERE id=:id", { replacements: { id: k.inv.unit.id } });
    await expect(scheduleViewing(sq(), agentCtx, { leadId: lead.lead.id, unitId: k.inv.unit.id, scheduledAt: inHours(48) })).rejects.toThrow(/cannot be viewed/);

    expect((await checkInViewing(sq(), agentCtx, v.id)).status).toBe("checked_in");
    await expect(completeViewing(sq(), agentCtx, v.id, { rating: 9, interest: "high" })).rejects.toThrow(/Rating/);
    const done = await completeViewing(sq(), agentCtx, v.id, { rating: 5, interest: "high", notes: "Loved it" });
    expect(done.status).toBe("completed");
    await expect(completeViewing(sq(), agentCtx, v.id, { rating: 4, interest: "low" })).rejects.toThrow(/cannot be completed/);
    const fb = await sq().query<{ interest: string }>("SELECT interest FROM viewing_feedback WHERE tenant_id=:t AND viewing_id=:v", { replacements: { t: t.tenantId, v: v.id }, type: QueryTypes.SELECT });
    expect(fb).toEqual([{ interest: "high" }]);
  });

  it("never double-books an agent under concurrent requests", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const at = inHours(30);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => scheduleViewing(sq(), k.agent.ctx, { contactId: k.contact.id, scheduledAt: at })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listViewings(sq(), k.agent.ctx, { limit: 50, offset: 0 }))).toHaveLength(1);
  });

  it("enforces who can book for whom, requires a cancellation reason, and hides viewings across agents and tenants", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await expect(scheduleViewing(sq(), k.other.ctx, { contactId: k.contact.id, agentUserId: k.agent.id, scheduledAt: inHours(20) })).rejects.toBeInstanceOf(ForbiddenError);
    const v = await scheduleViewing(sq(), k.mgr.ctx, { contactId: k.contact.id, agentUserId: k.agent.id, scheduledAt: inHours(20) }); // manager may
    await expect(cancelViewing(sq(), k.agent.ctx, v.id, "  ")).rejects.toThrow(/reason/);
    expect((await listViewings(sq(), k.other.ctx, { limit: 50, offset: 0 })).map((x: any) => x.id)).not.toContain(v.id);
    await expect(checkInViewing(sq(), k.other.ctx, v.id)).rejects.toBeInstanceOf(NotFoundError);
    const foreign = await makeTenant();
    await expect(checkInViewing(sq(), foreign.admin, v.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await cancelViewing(sq(), k.agent.ctx, v.id, "customer unavailable")).status).toBe("cancelled");
    await expect(cancelViewing(sq(), k.agent.ctx, v.id, "again")).rejects.toThrow(/cannot become/);
  });
});

describe("offers and reservations", () => {
  it("alternates counter-offers with an immutable revision history and needs manager approval to accept", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const offer = await createOffer(sq(), k.agent.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, amount: 1_800_000 });
    expect(offer).toMatchObject({ status: "submitted" });
    await expect(counterOffer(sq(), k.agent.ctx, offer.id, { amount: 1_850_000, by: "buyer" })).rejects.toThrow(/turn/);
    expect((await counterOffer(sq(), k.agent.ctx, offer.id, { amount: 2_000_000, by: "seller" })).status).toBe("countered");
    expect((await counterOffer(sq(), k.agent.ctx, offer.id, { amount: 1_900_000, by: "buyer" })).status).toBe("submitted");
    const detail = await getOffer(sq(), k.agent.ctx, offer.id);
    expect(detail.revisions.map((r: any) => [r.revision, Number(r.amount), r.byParty])).toEqual([[1, 1_800_000, "buyer"], [2, 2_000_000, "seller"], [3, 1_900_000, "buyer"]]);
    expect(Number(detail.currentAmount)).toBe(1_900_000);
    await expect(sq().query("UPDATE offer_revisions SET amount=1 WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);

    await expect(acceptOffer(sq(), k.agent.ctx, offer.id)).rejects.toBeInstanceOf(ForbiddenError);
    const rival = await createOffer(sq(), k.other.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, amount: 1_700_000 });
    const accepted = await acceptOffer(sq(), k.mgr.ctx, offer.id);
    expect(accepted.status).toBe("accepted");
    expect((await getOffer(sq(), k.mgr.ctx, rival.id)).status).toBe("rejected"); // rival closed in the same transaction
    await expect(rejectOffer(sq(), k.agent.ctx, offer.id)).rejects.toThrow(/cannot be rejected/);
  });

  it("expires lapsed offers via the sweep and refuses to accept them", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const offer = await createOffer(sq(), k.agent.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, amount: 1_000_000, validUntil: inHours(1) });
    await sq().query("UPDATE offers SET valid_until = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id=:id", { replacements: { id: offer.id } });
    await expect(acceptOffer(sq(), k.mgr.ctx, offer.id)).rejects.toThrow(/expired/);
    expect(await expireOffers(sq(), k.mgr.ctx)).toEqual([offer.id]);
    expect((await getOffer(sq(), k.mgr.ctx, offer.id)).status).toBe("expired");
    expect(await expireOffers(sq(), k.mgr.ctx)).toEqual([]);
  });

  it("reserves a unit exactly once (even concurrently), unpublishes its listing, and releases it on cancel or expiry", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const offer = await acceptedOffer(t, k);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>).value;
    const unit = async () => (await sq().query<{ status: string }>("SELECT status FROM units WHERE id=:id", { replacements: { id: k.inv.unit.id }, type: QueryTypes.SELECT }))[0]!.status;
    expect(await unit()).toBe("reserved");
    await expect(cancelReservation(sq(), k.mgr.ctx, winner.id, "")).rejects.toThrow(/reason/);
    await cancelReservation(sq(), k.mgr.ctx, winner.id, "customer changed mind");
    expect(await unit()).toBe("available");

    const again = await createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id, holdHours: 1 });
    await sq().query("UPDATE reservations SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id=:id", { replacements: { id: again.id } });
    expect(await expireReservations(sq(), k.mgr.ctx)).toEqual([again.id]);
    expect(await unit()).toBe("available");
  });

  it("only reserves against an accepted offer for that unit, and only for reservation managers", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const offer = await createOffer(sq(), k.agent.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, amount: 1_500_000 });
    await expect(createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id })).rejects.toThrow(/accepted offer/);
    await expect(createReservation(sq(), k.agent.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id })).rejects.toBeInstanceOf(ForbiddenError);
    const other = await makeInventory(t);
    await expect(createReservation(sq(), k.mgr.ctx, { unitId: other.unit.id, contactId: k.contact.id, offerId: offer.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createOffer(sq(), k.agent.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, amount: -5 })).rejects.toThrow(/positive/);
  });

  it("takes a published listing down when its unit is reserved", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const lic = await makeVerifiedLicences(t, k.agent.id);
    const l = await createListing(sq(), t.admin, { unitId: k.inv.unit.id, purpose: "sale", title: "T", description: "D", price: 2_000_000, agentUserId: k.agent.id, brokerLicenceId: lic.company.id });
    for (let i = 0; i < 3; i++) await addListingMedia(sq(), t.admin, l.id, { kind: "image", storageKey: `k/${i}.jpg` });
    await verifyPermit(sq(), t.admin, (await addPermit(sq(), t.admin, l.id, { permitNo: uniq("TRK"), authority: "DLD_TRAKHEESI", expiresAt: dateOffset(60) })).id, "valid");
    await publishListing(sq(), t.admin, l.id);
    const offer = await acceptedOffer(t, k);
    await createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id });
    const st = await sq().query<{ status: string }>("SELECT status FROM listings WHERE id=:id", { replacements: { id: l.id }, type: QueryTypes.SELECT });
    expect(st[0]!.status).toBe("unpublished");
  });
});

describe("deals", () => {
  it("starts from a reservation with parties, milestones and history, and only one open deal per unit", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const { deal, res, offer } = await openDeal(t, k);
    expect(deal).toMatchObject({ stage: "reserved", status: "open", dealType: "sale", agentUserId: k.agent.id });
    expect(Number(deal.amount)).toBe(1_950_000);
    const d = await getDeal(sq(), k.mgr.ctx, deal.id);
    expect(d.parties.map((p: any) => p.role)).toContain("buyer");
    expect(d.milestones.map((m: any) => m.key)).toEqual(["deposit", "contract_signed", "noc", "registration_completed"]);
    expect(Number(d.milestones[0].amount)).toBe(100_000);
    expect(d.stageEvents.map((e: any) => e.toStage)).toEqual(["reserved"]);
    const r = await sq().query<{ status: string; deal_id: string }>("SELECT status, deal_id FROM reservations WHERE id=:id", { replacements: { id: res.id }, type: QueryTypes.SELECT });
    expect(r[0]).toMatchObject({ status: "converted", deal_id: deal.id });
    await expect(createDeal(sq(), k.mgr.ctx, { reservationId: res.id })).rejects.toThrow(/converted reservation/);
    await expect(createDeal(sq(), k.agent.ctx, { reservationId: res.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(sq().query("UPDATE deal_stage_events SET to_stage='closed' WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);
    void offer;
  });

  it("enforces stage gates, sequential stages, manager-only overrides and backward moves with a reason", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const { deal } = await openDeal(t, k);
    const agent = await contextFor(t.tenantId, k.agent.id);
    const mgr = await contextFor(t.tenantId, k.mgr.id);

    const blocked: any = await advanceDealStage(sq(), agent, deal.id, { to: "contract" }).catch((e) => e);
    expect(blocked).toBeInstanceOf(DealBlockedError);
    expect(blocked.reasons).toEqual(["Deposit has not been received"]);
    await expect(advanceDealStage(sq(), agent, deal.id, { to: "payment" })).rejects.toThrow(/cannot be skipped/);
    await expect(completeMilestone(sq(), agent, deal.id, "deposit", { reason: "trust me" })).rejects.toBeInstanceOf(ForbiddenError); // evidence-driven: manager only
    await expect(completeMilestone(sq(), mgr, deal.id, "deposit")).rejects.toThrow(/reason/);
    await completeMilestone(sq(), mgr, deal.id, "deposit", { reason: "bank statement seen" });
    expect((await advanceDealStage(sq(), agent, deal.id, { to: "contract" })).stage).toBe("contract");

    await expect(advanceDealStage(sq(), agent, deal.id, { to: "reserved" })).rejects.toBeInstanceOf(ForbiddenError); // stepping back
    await expect(advanceDealStage(sq(), mgr, deal.id, { to: "reserved" })).rejects.toThrow(/reason/);
    expect((await advanceDealStage(sq(), mgr, deal.id, { to: "reserved", reason: "contract terms disputed" })).stage).toBe("reserved");
    const audit = await sq().query<{ action: string }>("SELECT action FROM audit_events WHERE tenant_id=:t AND entity_type IN ('deal','deal_milestone')", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["deal.created", "milestone.completed_manually"]));
  });

  it("holds registration until every instalment is settled and validates the payment plan", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const { deal } = await openDeal(t, k, { amount: 1_000_000 });
    const mgr = await contextFor(t.tenantId, k.mgr.id);
    await expect(setPaymentPlan(sq(), mgr, deal.id, [{ title: "Too big", dueDate: dateOffset(30), amount: 950_000 }])).rejects.toThrow(/exceed the deal amount/);
    const plan = await setPaymentPlan(sq(), mgr, deal.id, [
      { title: "1st instalment", dueDate: dateOffset(30), amount: 400_000 },
      { title: "2nd instalment", dueDate: dateOffset(90), amount: 500_000 },
    ]);
    expect(plan.milestones.filter((m: any) => String(m.key).startsWith("installment_")).map((m: any) => Number(m.amount))).toEqual([400_000, 500_000]);
    await walkTo(k, deal.id, "payment");
    const blocked: any = await advanceDealStage(sq(), mgr, deal.id, { to: "registration" }).catch((e) => e);
    expect(blocked.reasons[0]).toMatch(/2 payment-plan instalment/);
    await completeMilestone(sq(), mgr, deal.id, "installment_1", { reason: "received in escrow" });
    await completeMilestone(sq(), mgr, deal.id, "installment_2", { waive: true, reason: "developer waived final instalment" });
    expect((await advanceDealStage(sq(), mgr, deal.id, { to: "registration" })).stage).toBe("registration");
  });

  it("closes a deal: unit sold, lead won, commission calculated exactly, approval needs step-up and the right role", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await createRoutingRule(sq(), t.admin, { name: "a", conditions: {}, target: { userIds: [k.agent.id] } });
    const lead = await ingestLead(sq(), t.tenantId, { contact: { firstName: "Won", phone: phone() }, purpose: "buy", sourceCode: "website" });
    await createCommissionPlan(sq(), t.admin, { name: "Standard sales", dealType: "sale", ratePct: 2, splits: [{ role: "agent", pct: 50 }, { role: "brokerage", pct: 30 }, { role: "introducer", pct: 20 }] });
    const agentCtx = await contextFor(t.tenantId, k.agent.id);
    const offer = await acceptedOffer(t, k, { amount: 1_234_567.89, leadId: lead.lead.id });
    const res = await createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id, depositAmount: 50_000 });
    const deal = await createDeal(sq(), k.mgr.ctx, { reservationId: res.id });
    await walkTo(k, deal.id, "closed");

    const closed = await getDeal(sq(), k.mgr.ctx, deal.id);
    expect(closed).toMatchObject({ stage: "closed", status: "closed" });
    expect(closed.stageEvents.map((e: any) => e.toStage)).toEqual(["reserved", "contract", "signed", "payment", "registration", "closed"]);
    expect((await sq().query<{ status: string }>("SELECT status FROM units WHERE id=:id", { replacements: { id: k.inv.unit.id }, type: QueryTypes.SELECT }))[0]!.status).toBe("sold");
    expect((await getLead(sq(), t.admin, lead.lead.id)).status).toBe("won");

    const [calc] = await listCommissions(sq(), t.admin, { limit: 10, offset: 0 });
    expect(Number(calc.grossAmount)).toBe(1_234_567.89);
    expect(Number(calc.commissionAmount)).toBe(24_691.36); // 2% of 1,234,567.89 = 24,691.3578 -> half-up to the fils
    const parts = calc.splits.map((s: any) => toMinor(s.amount));
    expect(parts.reduce((a: number, b: number) => a + b, 0)).toBe(toMinor(calc.commissionAmount)); // no fils lost or invented
    expect(calc.splits.find((s: any) => s.role === "agent").userId).toBe(k.agent.id);
    expect(calc.agentUserId).toBe(k.agent.id);

    // The agent sees only their commission; nobody else in the branch does
    expect((await listCommissions(sq(), agentCtx, { limit: 10, offset: 0 })).map((c: any) => c.id)).toEqual([calc.id]);
    expect(await listCommissions(sq(), await contextFor(t.tenantId, k.other.id), { limit: 10, offset: 0 })).toEqual([]);
    const noStepUp = await contextFor(t.tenantId, t.adminId, { stepUp: false });
    await expect(approveCommission(sq(), noStepUp, calc.id)).rejects.toMatchObject({ code: "step_up_required" });
    await expect(approveCommission(sq(), k.mgr.ctx, calc.id)).rejects.toBeInstanceOf(ForbiddenError);
    const approved = await approveCommission(sq(), t.admin, calc.id);
    expect(approved).toMatchObject({ status: "approved", approvedBy: t.adminId });
    await expect(approveCommission(sq(), t.admin, calc.id)).rejects.toThrow(/cannot be approved/);
    await expect(advanceDealStage(sq(), k.mgr.ctx, deal.id, { to: "reserved", reason: "x" })).rejects.toThrow(/closed deal/);
  });

  it("cancels a deal (reason required), frees the unit and reservation, and refuses once money has been received", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const { deal, res } = await openDeal(t, k);
    await expect(cancelDeal(sq(), k.agent.ctx, deal.id, "no")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelDeal(sq(), k.mgr.ctx, deal.id, " ")).rejects.toThrow(/reason/);
    const cancelled = await cancelDeal(sq(), k.mgr.ctx, deal.id, "buyer financing fell through");
    expect(cancelled).toMatchObject({ stage: "cancelled", status: "cancelled" });
    expect((await sq().query<{ status: string }>("SELECT status FROM units WHERE id=:id", { replacements: { id: k.inv.unit.id }, type: QueryTypes.SELECT }))[0]!.status).toBe("available");
    expect((await sq().query<{ status: string }>("SELECT status FROM reservations WHERE id=:id", { replacements: { id: res.id }, type: QueryTypes.SELECT }))[0]!.status).toBe("cancelled");
    await expect(advanceDealStage(sq(), k.mgr.ctx, deal.id, { to: "contract" })).rejects.toThrow(/cancelled deal/);

    // A second deal on the same unit can now start; once a payment has been received it cannot be cancelled silently
    const second = await openDeal(t, k, { amount: 1_800_000 });
    await sq().query(
      "INSERT INTO payments (id, tenant_id, contact_id, deal_id, amount, currency, method, provider, status, received_at, created_at, updated_at) VALUES (UUID(), :t, :c, :d, 100000, 'AED', 'bank_transfer', 'manual', 'succeeded', NOW(3), NOW(3), NOW(3))",
      { replacements: { t: t.tenantId, c: k.contact.id, d: second.deal.id } },
    );
    await expect(cancelDeal(sq(), k.mgr.ctx, second.deal.id, "changed mind")).rejects.toThrow(/refund/);
  });

  it("scopes deals to the agent/branch and never crosses tenants", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const { deal } = await openDeal(t, k);
    expect((await listDeals(sq(), k.agent.ctx, { limit: 10, offset: 0 })).map((d: any) => d.id)).toEqual([deal.id]);
    expect(await listDeals(sq(), k.other.ctx, { limit: 10, offset: 0 })).toEqual([]);
    await expect(getDeal(sq(), k.other.ctx, deal.id)).rejects.toBeInstanceOf(NotFoundError);
    const foreign = await makeTenant();
    await expect(getDeal(sq(), foreign.admin, deal.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setUnitStatus(sq(), foreign.admin, k.inv.unit.id, "blocked")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("money helpers", () => {
  it("allocates by percentage without losing a fils and rejects bad splits", () => {
    expect(allocateByPct(10_000, [33.333, 33.333, 33.334]).reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(allocateByPct(1, [50, 50]).sort()).toEqual([0, 1]);
    expect(allocateByPct(100, [60, 40])).toEqual([60, 40]);
    expect(() => allocateByPct(100, [60, 30])).toThrow(/100/);
    expect(toMinor("2100000.10")).toBe(210_000_010);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(fromMinor(24_691_36)).toBe("24691.36");
  });
});

void addLeadActivity;
