import { afterAll, describe, expect, it } from "vitest";
import {
  addSupportComment, approveCommission, archiveNotice, cancelPayout, closeOwnSupportTicket, countUnreadNotices, createCommissionPlan, createDeal, createReservation, createSupportTicket, decidePayout,
  getSupportTicket, listAllNotices, listNoticesForMe, listPayable, listPayouts, listSupportTickets, listMyNotifications, markNotice, markPayoutPaid, noticeReceipts, requestPayout, saveNotice,
  updateSupportTicket, upsertAgentProfile,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, testDb, uniq } from "./helpers";
import { acceptedOffer, kit, walkTo } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);

describe("commission payout requests", () => {
  it("lets an agent request their approved share once, and finance approve, reject, or pay with the right controls", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await createCommissionPlan(sq(), t.admin, { name: uniq("Plan"), dealType: "sale", ratePct: 2, splits: [{ role: "agent", pct: 60 }, { role: "company", pct: 40 }] });
    const offer = await acceptedOffer(t, k, { amount: 1_000_000 });
    const res = await createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id, depositAmount: 50_000 });
    const deal = await createDeal(sq(), k.mgr.ctx, { reservationId: res.id });
    await walkTo(k, deal.id, "closed");

    const agentCtx = await contextFor(t.tenantId, k.agent.id);
    expect(await listPayable(sq(), agentCtx)).toHaveLength(0); // not approved yet
    const [calc] = (await (await import("@reales/domain")).listCommissions(sq(), t.admin, { limit: 5, offset: 0 }));
    await approveCommission(sq(), t.admin, calc.id);
    const payable = await listPayable(sq(), agentCtx);
    expect(payable).toHaveLength(1);
    expect(payable[0]).toMatchObject({ amount: "12000.00", vat: "0.00" }); // 60% of 20,000; internal agent: no VAT

    const req = await requestPayout(sq(), agentCtx, { calculationIds: [calc.id], note: "October" });
    expect(req).toMatchObject({ status: "pending", totalAmount: "12000.00" });
    await expect(requestPayout(sq(), agentCtx, { calculationIds: [calc.id] })).rejects.toThrow(/not available/); // already requested
    expect(await listPayable(sq(), agentCtx)).toHaveLength(0);
    // other people cannot see it; finance can
    expect(await listPayouts(sq(), await contextFor(t.tenantId, k.other.id))).toHaveLength(0);
    expect((await listPayouts(sq(), t.admin)).map((p: any) => p.id)).toContain(req.id);
    expect((await listMyNotifications(sq(), t.admin)).some((n: any) => n.kind === "payout.requested")).toBe(true);

    // finance controls
    await expect(decidePayout(sq(), agentCtx, req.id, { outcome: "approved" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decidePayout(sq(), t.admin, req.id, { outcome: "rejected" })).rejects.toThrow(/reason/);
    await decidePayout(sq(), t.admin, req.id, { outcome: "rejected", reason: "Invoice missing" });
    await expect(decidePayout(sq(), t.admin, req.id, { outcome: "approved" })).rejects.toThrow(/cannot be decided/);
    // rejection frees the commission to be requested again
    expect(await listPayable(sq(), agentCtx)).toHaveLength(1);
    const again = await requestPayout(sq(), agentCtx, { calculationIds: [calc.id] });
    expect((await cancelPayout(sq(), agentCtx, again.id)).status).toBe("cancelled");
    const third = await requestPayout(sq(), agentCtx, { calculationIds: [calc.id] });
    await expect(markPayoutPaid(sq(), t.admin, third.id, "TRX-1")).rejects.toThrow(/approved/);
    expect((await decidePayout(sq(), t.admin, third.id, { outcome: "approved" })).status).toBe("approved");
    await expect(cancelPayout(sq(), agentCtx, third.id)).rejects.toThrow(/cannot be cancelled/);
    await expect(markPayoutPaid(sq(), t.admin, third.id, " ")).rejects.toThrow(/reference/);
    expect(await markPayoutPaid(sq(), t.admin, third.id, "TRX-9")).toMatchObject({ status: "paid", paidReference: "TRX-9" });
    expect((await listMyNotifications(sq(), agentCtx)).map((n: any) => n.kind)).toEqual(expect.arrayContaining(["payout.rejected", "payout.approved", "payout.paid"]));
    expect(await listPayable(sq(), agentCtx)).toHaveLength(0); // paid: gone for good
  });

  it("charges VAT on an external agent's share and demands their invoice number", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await upsertAgentProfile(sq(), t.admin, { userId: k.agent.id, agentType: "external", agencyName: "Partner Realty" });
    await createCommissionPlan(sq(), t.admin, { name: uniq("Ext"), dealType: "sale", agentType: "external", ratePct: 2, vatPct: 5, splits: [{ role: "agent", pct: 50 }, { role: "company", pct: 50 }] });
    const offer = await acceptedOffer(t, k, { amount: 1_000_000 });
    const res = await createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id, depositAmount: 50_000 });
    const deal = await createDeal(sq(), k.mgr.ctx, { reservationId: res.id });
    await walkTo(k, deal.id, "closed");
    const [calc] = await (await import("@reales/domain")).listCommissions(sq(), t.admin, { limit: 5, offset: 0 });
    await approveCommission(sq(), t.admin, calc.id);
    const ctx = await contextFor(t.tenantId, k.agent.id);
    expect((await listPayable(sq(), ctx))[0]).toMatchObject({ amount: "10000.00", vat: "500.00" });
    await expect(requestPayout(sq(), ctx, { calculationIds: [calc.id] })).rejects.toThrow(/invoice/);
    expect(await requestPayout(sq(), ctx, { calculationIds: [calc.id], invoiceRef: "INV-1001" })).toMatchObject({ totalAmount: "10500.00", vatAmount: "500.00", netAmount: "10000.00", invoiceRef: "INV-1001" });
  });
});

describe("noticeboard", () => {
  it("shows live notices to the audience, tracks reads and acknowledgements, and hides archived or expired ones", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await expect(saveNotice(sq(), k.agent.ctx, { title: "x", body: "y" })).rejects.toBeInstanceOf(ForbiddenError);
    const n = await saveNotice(sq(), t.admin, { title: "New commission policy", body: "Please read the attached summary.", pinned: true, requiresAck: true });
    const future = await saveNotice(sq(), t.admin, { title: "Later", body: "not yet", publishAt: new Date(Date.now() + 86_400_000).toISOString() });
    const old = await saveNotice(sq(), t.admin, { title: "Old", body: "gone", publishAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
    await expect(saveNotice(sq(), t.admin, { title: "bad", body: "x", publishAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow(/expire after/);

    const agentCtx = await contextFor(t.tenantId, k.agent.id);
    const mine = await listNoticesForMe(sq(), agentCtx);
    expect(mine.map((x: any) => x.id)).toEqual([n.id]); // not the future one, not the expired one
    expect(mine[0]).toMatchObject({ read: false, acked: false, pinned: true });
    expect(await countUnreadNotices(sq(), agentCtx)).toBe(1);
    expect((await listMyNotifications(sq(), agentCtx)).some((x: any) => x.kind === "notice.posted")).toBe(true);
    await markNotice(sq(), agentCtx, n.id); // read
    expect(await countUnreadNotices(sq(), agentCtx)).toBe(1); // still needs the acknowledgement
    await markNotice(sq(), agentCtx, n.id, true);
    expect(await countUnreadNotices(sq(), agentCtx)).toBe(0);
    await expect(markNotice(sq(), agentCtx, future.id)).rejects.toThrow(/not found/i);

    const receipts = await noticeReceipts(sq(), t.admin, n.id);
    expect(receipts).toMatchObject({ requiresAck: true, acked: 1 });
    expect(receipts.pending.length).toBeGreaterThan(0);
    await archiveNotice(sq(), t.admin, n.id);
    expect(await listNoticesForMe(sq(), agentCtx)).toHaveLength(0);
    expect((await listAllNotices(sq(), t.admin)).length).toBe(3);
    void old;
  });
});

describe("support desk", () => {
  it("keeps tickets private to their requester, lets the desk reply with internal notes, and tracks response and resolution", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const agentCtx = await contextFor(t.tenantId, k.agent.id);
    const otherCtx = await contextFor(t.tenantId, k.other.id);
    const ticket = await createSupportTicket(sq(), agentCtx, { subject: "Cannot export leads", body: "The export button errors out.", category: "bug", priority: "high" });
    expect(ticket).toMatchObject({ number: 1, status: "open", priority: "high" });
    expect(new Date(ticket.dueAt).getTime() - Date.now()).toBeLessThan(8 * 3_600_000 + 60_000); // high = 8 hour first response
    const second = await createSupportTicket(sq(), otherCtx, { subject: "Question", body: "How do I add a unit?" });
    expect(second.number).toBe(2);
    // privacy
    expect((await listSupportTickets(sq(), agentCtx)).map((x: any) => x.id)).toEqual([ticket.id]);
    await expect(getSupportTicket(sq(), otherCtx, ticket.id)).rejects.toThrow(/not found/i);
    expect((await listSupportTickets(sq(), t.admin)).length).toBe(2);
    expect((await listMyNotifications(sq(), t.admin)).some((n: any) => n.kind === "support.new")).toBe(true);
    // the desk replies; an internal note is hidden from the requester
    await expect(updateSupportTicket(sq(), agentCtx, ticket.id, { status: "resolved" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addSupportComment(sq(), agentCtx, ticket.id, { body: "psst", internal: true })).rejects.toBeInstanceOf(ForbiddenError);
    await addSupportComment(sq(), t.admin, ticket.id, { body: "Looks like a permissions issue", internal: true });
    expect((await getSupportTicket(sq(), t.admin, ticket.id)).firstResponseAt).toBeNull(); // an internal note is not a response
    await addSupportComment(sq(), t.admin, ticket.id, { body: "Fixed, please retry." });
    const seen = await getSupportTicket(sq(), agentCtx, ticket.id);
    expect(seen.comments.map((c: any) => c.body)).toEqual(["Fixed, please retry."]);
    expect((await getSupportTicket(sq(), t.admin, ticket.id)).firstResponseAt).toBeTruthy();
    expect((await listMyNotifications(sq(), agentCtx)).some((n: any) => n.kind === "support.reply")).toBe(true);
    // assign + resolve, requester replies and it reopens, then closes it themselves
    expect((await updateSupportTicket(sq(), t.admin, ticket.id, { assigneeId: k.mgr.id })).status).toBe("in_progress");
    expect((await updateSupportTicket(sq(), t.admin, ticket.id, { status: "resolved" })).resolvedAt).toBeTruthy();
    await addSupportComment(sq(), agentCtx, ticket.id, { body: "Still broken on Safari" });
    expect((await getSupportTicket(sq(), agentCtx, ticket.id)).status).toBe("open");
    expect((await closeOwnSupportTicket(sq(), agentCtx, ticket.id)).status).toBe("closed");
    await expect(addSupportComment(sq(), agentCtx, ticket.id, { body: "more" })).rejects.toThrow(/closed/);
  });
});
