import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { AuthError } from "@reales/auth";
import {
  addClaimEvidence, addClaimItems, approveClaimBatch, approveCommission, cancelClaimBatch, claimReleaseDueSweep, createClaimBatch, createCommissionPlan, createDeal, createReservation, dubaiDate,
  getClaimBatch, listClaimBatches, listClaimCandidates, listCommissionPlans, listCommissions, listMyNotifications, listPayable, markCommissionPaid, rejectClaimBatch, releaseClaimBatch, removeClaimItem,
  reverseClaimBatch, scheduleClaimRelease, submitClaimBatch, verifyClaimBatch, verifyClaimItem,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { contextFor, closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { acceptedOffer, kit, walkTo } from "./deal-helpers";
import { makeInventory } from "./brokerage-helpers";

const sq = () => testDb();
afterAll(closeTestDb);

type T = Awaited<ReturnType<typeof makeTenant>>;
const stepped = (t: T, userId: string) => contextFor(t.tenantId, userId, { stepUp: true });

/** Close `n` deals (each on its own unit) and approve their commissions; returns the calculation ids. */
async function approvedCommissions(t: T, n: number) {
  const k = await kit(t);
  if (!((await listCommissionPlans(sq(), t.admin)) as any[]).length) await createCommissionPlan(sq(), t.admin, { name: uniq("Plan"), dealType: "sale", ratePct: 2, splits: [{ role: "agent", pct: 60 }, { role: "company", pct: 40 }] });
  for (let i = 0; i < n; i++) {
    const inv = await makeInventory(t);
    const kk = { ...k, inv };
    const offer = await acceptedOffer(t, kk, { amount: 1_000_000 + i * 100_000 });
    const res = await createReservation(sq(), k.mgr.ctx, { unitId: inv.unit.id, contactId: k.contact.id, offerId: offer.id, depositAmount: 50_000 });
    const deal = await createDeal(sq(), k.mgr.ctx, { reservationId: res.id });
    await walkTo(kk, deal.id, "closed");
  }
  const calcs = ((await listCommissions(sq(), t.admin, { limit: 50, offset: 0 })) as any[]).filter((c) => c.status === "calculated");
  for (const c of calcs) await approveCommission(sq(), t.admin, c.id);
  return { k, ids: calcs.map((c) => c.id as string), calcs };
}

/** Three finance people plus the admin: maker + releaser (finance officers) and a controller (approver / reverser). */
async function team(t: T) {
  const maker = await makeUser(t, ["finance_officer"]);
  const checker = await makeUser(t, ["finance_officer"]);
  const controller = await makeUser(t, ["finance_controller"]);
  return { maker, checker, controller, makerCtx: await stepped(t, maker.id), checkerCtx: await stepped(t, checker.id), controllerCtx: await stepped(t, controller.id) };
}

/** Drive a fresh batch up to a given stage with the right people. */
async function batchAt(t: T, tm: Awaited<ReturnType<typeof team>>, ids: string[], stage: "draft" | "submitted" | "verified" | "approved" | "scheduled") {
  const b: any = await createClaimBatch(sq(), tm.makerCtx, { title: "October", calculationIds: ids });
  if (stage === "draft") return b;
  await submitClaimBatch(sq(), tm.makerCtx, b.id);
  if (stage === "submitted") return b;
  const full: any = await getClaimBatch(sq(), tm.checkerCtx, b.id);
  await addClaimEvidence(sq(), tm.makerCtx, b.id, { kind: "bank_statement", description: "Developer remittance advice" });
  for (const i of full.items) await verifyClaimItem(sq(), tm.checkerCtx, b.id, i.id, { outcome: "verified" });
  await verifyClaimBatch(sq(), tm.checkerCtx, b.id);
  if (stage === "verified") return b;
  await approveClaimBatch(sq(), tm.controllerCtx, b.id);
  if (stage === "approved") return b;
  await scheduleClaimRelease(sq(), tm.controllerCtx, b.id, dubaiDate());
  return b;
}

describe("commission claim batches", () => {
  it("builds a batch from approved, unclaimed commissions only, one live claim per commission", async () => {
    const t = await makeTenant();
    const { ids, calcs, k } = await approvedCommissions(t, 2);
    const tm = await team(t);
    expect((await listClaimCandidates(sq(), tm.makerCtx)).map((c: any) => c.id).sort()).toEqual([...ids].sort());
    await expect(createClaimBatch(sq(), tm.makerCtx, { calculationIds: [] })).rejects.toThrow(/at least one/);
    await expect(createClaimBatch(sq(), tm.checkerCtx, { calculationIds: ["00000000-0000-4000-8000-000000000000"] })).rejects.toThrow(/not found/i);

    const b: any = await createClaimBatch(sq(), tm.makerCtx, { calculationIds: ids });
    expect(b).toMatchObject({ status: "draft", itemCount: 2, createdBy: tm.maker.id });
    const expected = calcs.reduce((a: number, c: any) => a + Math.round(Number(c.commissionAmount) * 100), 0) / 100;
    expect(Number(b.amount)).toBeCloseTo(expected, 2);
    expect(b.number).toBeGreaterThan(0);

    // the same commissions cannot be claimed twice, nor requested as a payout while claimed, nor paid one by one
    await expect(createClaimBatch(sq(), tm.makerCtx, { calculationIds: [ids[0]!] })).rejects.toThrow(/not available to claim/);
    expect(await listPayable(sq(), await contextFor(t.tenantId, k.agent.id))).toHaveLength(0);
    await expect(markCommissionPaid(sq(), t.admin, ids[0]!, "BANK-1")).rejects.toThrow(/claim batch/);

    // items can be removed while drafting, and then become claimable again
    const detail: any = await getClaimBatch(sq(), tm.makerCtx, b.id);
    await removeClaimItem(sq(), tm.makerCtx, b.id, detail.items[0].id);
    expect((await getClaimBatch(sq(), tm.makerCtx, b.id)).itemCount).toBe(1);
    expect((await listClaimCandidates(sq(), tm.makerCtx)).map((c: any) => c.id)).toContain(detail.items[0].calculationId);
    await addClaimItems(sq(), tm.makerCtx, b.id, [detail.items[0].calculationId]);
    expect((await getClaimBatch(sq(), tm.makerCtx, b.id)).itemCount).toBe(2);

    // only people with the finance-wide claim permissions can use any of this
    const agent = await makeUser(t, ["agent"]);
    await expect(listClaimCandidates(sq(), agent.ctx)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listClaimBatches(sq(), agent.ctx)).rejects.toBeInstanceOf(ForbiddenError);
    const other = await makeTenant();
    await expect(getClaimBatch(sq(), other.admin, b.id)).rejects.toThrow(/not found/i);
  });

  it("walks the stages with four-eyes: maker, checker, approver, releaser", async () => {
    const t = await makeTenant();
    const { ids } = await approvedCommissions(t, 2);
    const tm = await team(t);
    const b = await batchAt(t, tm, ids, "draft");
    await expect(submitClaimBatch(sq(), tm.checkerCtx, b.id)).rejects.toBeInstanceOf(ForbiddenError); // only the builder submits
    await expect(verifyClaimBatch(sq(), tm.checkerCtx, b.id)).rejects.toThrow(/cannot be verified/); // not submitted yet
    await submitClaimBatch(sq(), tm.makerCtx, b.id);
    expect((await listMyNotifications(sq(), tm.checker.ctx)).some((n: any) => n.kind === "claim.submitted")).toBe(true);

    const full: any = await getClaimBatch(sq(), tm.checkerCtx, b.id);
    await expect(verifyClaimItem(sq(), tm.makerCtx, b.id, full.items[0].id, { outcome: "verified" })).rejects.toThrow(/Segregation/); // the maker cannot check their own work
    await expect(verifyClaimItem(sq(), tm.checkerCtx, b.id, full.items[0].id, { outcome: "flagged" })).rejects.toThrow(/what is wrong/);
    await verifyClaimItem(sq(), tm.checkerCtx, b.id, full.items[0].id, { outcome: "flagged", note: "Amount does not match the SPA" });
    await expect(verifyClaimBatch(sq(), tm.checkerCtx, b.id)).rejects.toThrow(/not verified yet or are flagged/);
    for (const i of full.items) await verifyClaimItem(sq(), tm.checkerCtx, b.id, i.id, { outcome: "verified" });
    await expect(verifyClaimBatch(sq(), tm.checkerCtx, b.id)).rejects.toThrow(/evidence/);
    await addClaimEvidence(sq(), tm.makerCtx, b.id, { kind: "invoice", description: "Developer commission invoice 4471" });
    await expect(verifyClaimBatch(sq(), tm.makerCtx, b.id)).rejects.toThrow(/Segregation/);
    expect(await verifyClaimBatch(sq(), tm.checkerCtx, b.id)).toMatchObject({ status: "verified", verifiedBy: tm.checker.id });

    // approving needs the approve permission AND a fresh second factor; the maker/verifier cannot approve
    await expect(approveClaimBatch(sq(), tm.checkerCtx, b.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveClaimBatch(sq(), tm.controller.ctx, b.id)).rejects.toBeInstanceOf(AuthError); // no step-up
    expect(await approveClaimBatch(sq(), tm.controllerCtx, b.id)).toMatchObject({ status: "approved", approvedBy: tm.controller.id });
    await expect(releaseClaimBatch(sq(), tm.checkerCtx, b.id, "BANK-9")).rejects.toThrow(/Schedule the release date first/);

    // the release date: not in the past, not released early, then released by someone other than builder/approver
    await expect(scheduleClaimRelease(sq(), tm.controllerCtx, b.id, "2020-01-01")).rejects.toThrow(/in the past/);
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await scheduleClaimRelease(sq(), tm.controllerCtx, b.id, tomorrow);
    await expect(releaseClaimBatch(sq(), tm.checkerCtx, b.id, "BANK-9")).rejects.toThrow(/cannot be released earlier/);
    await scheduleClaimRelease(sq(), tm.controllerCtx, b.id, dubaiDate());
    await expect(releaseClaimBatch(sq(), tm.checker.ctx, b.id, "BANK-9")).rejects.toBeInstanceOf(AuthError); // no step-up
    await expect(releaseClaimBatch(sq(), tm.checkerCtx, b.id, " ")).rejects.toThrow(/reference/);
    await expect(releaseClaimBatch(sq(), tm.makerCtx, b.id, "BANK-9")).rejects.toThrow(/Segregation/); // the builder cannot release
    expect(await sq().query("SELECT id FROM commission_calculations WHERE tenant_id=:t AND paid_at IS NOT NULL", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT })).toHaveLength(0);
    const released: any = await releaseClaimBatch(sq(), tm.checkerCtx, b.id, "BANK-9");
    expect(released).toMatchObject({ status: "released", releaseReference: "BANK-9", releasedBy: tm.checker.id });
    await expect(releaseClaimBatch(sq(), tm.checkerCtx, b.id, "BANK-9")).rejects.toThrow(/cannot be released/); // exactly once

    // every commission is now paid with the bank reference, and the log lists each stage in order
    const paid = await sq().query<any>("SELECT paid_reference, paid_by FROM commission_calculations WHERE tenant_id=:t AND paid_at IS NOT NULL", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(paid).toHaveLength(2);
    expect(paid.every((p) => p.paid_reference === "BANK-9" && p.paid_by === tm.checker.id)).toBe(true);
    const log: any = await getClaimBatch(sq(), tm.makerCtx, b.id);
    expect(log.decisions.map((d: any) => d.stage)).toEqual(["submit", "verify", "approve", "schedule", "schedule", "release"]);
    expect(log.decisions.find((d: any) => d.stage === "approve").actorEmail).toBe(tm.controller.email);
  });

  it("reverses a release so the commissions can be claimed again, and never by the person who released it", async () => {
    const t = await makeTenant();
    const { ids } = await approvedCommissions(t, 1);
    const tm = await team(t);
    const b = await batchAt(t, tm, ids, "scheduled");
    await releaseClaimBatch(sq(), tm.checkerCtx, b.id, "BANK-1");
    await expect(reverseClaimBatch(sq(), tm.checkerCtx, b.id, "Bank returned the transfer")).rejects.toBeInstanceOf(ForbiddenError); // lacks claim.reverse
    await expect(reverseClaimBatch(sq(), tm.controller.ctx, b.id, "Bank returned the transfer")).rejects.toBeInstanceOf(AuthError);
    await expect(reverseClaimBatch(sq(), tm.controllerCtx, b.id, " ")).rejects.toThrow(/reason/);
    const r: any = await reverseClaimBatch(sq(), tm.controllerCtx, b.id, "Bank returned the transfer");
    expect(r).toMatchObject({ status: "reversed", reversalReason: "Bank returned the transfer" });
    await expect(reverseClaimBatch(sq(), tm.controllerCtx, b.id, "again")).rejects.toThrow(/Only a released/);
    const [calc] = await sq().query<any>("SELECT paid_at, paid_by, paid_reference FROM commission_calculations WHERE id=:id", { replacements: { id: ids[0] }, type: QueryTypes.SELECT });
    expect(calc).toMatchObject({ paid_at: null, paid_by: null, paid_reference: null });
    expect((await listClaimCandidates(sq(), tm.makerCtx)).map((c: any) => c.id)).toContain(ids[0]); // claimable once more
    await expect(createClaimBatch(sq(), tm.makerCtx, { calculationIds: ids })).resolves.toMatchObject({ status: "draft" });
  });

  it("stops an admin approving, releasing or reversing their own work, and frees items on rejection or cancellation", async () => {
    const t = await makeTenant();
    const { ids } = await approvedCommissions(t, 2);
    const adminStep = await stepped(t, t.adminId);
    const tm = await team(t);

    // admin builds and submits, then cannot verify or approve it
    const own: any = await createClaimBatch(sq(), adminStep, { calculationIds: [ids[0]!] });
    await submitClaimBatch(sq(), adminStep, own.id);
    await expect(verifyClaimBatch(sq(), adminStep, own.id)).rejects.toThrow(/Segregation/);
    await addClaimEvidence(sq(), adminStep, own.id, { kind: "email", description: "Confirmation email" });
    const items: any = await getClaimBatch(sq(), adminStep, own.id);
    await verifyClaimItem(sq(), tm.checkerCtx, own.id, items.items[0].id, { outcome: "verified" });
    await verifyClaimBatch(sq(), tm.checkerCtx, own.id);
    await expect(approveClaimBatch(sq(), adminStep, own.id)).rejects.toThrow(/Segregation/); // built this batch, even for a full administrator
    // rejection by the approver sends it back and frees the commission
    await expect(rejectClaimBatch(sq(), tm.checkerCtx, own.id, "x")).rejects.toBeInstanceOf(ForbiddenError); // at "verified" only an approver may reject
    await expect(rejectClaimBatch(sq(), tm.controllerCtx, own.id, " ")).rejects.toThrow(/reason/);
    expect(await rejectClaimBatch(sq(), tm.controllerCtx, own.id, "Evidence incomplete")).toMatchObject({ status: "rejected", rejectionReason: "Evidence incomplete" });
    expect((await listMyNotifications(sq(), adminStep)).some((n: any) => n.kind === "claim.rejected")).toBe(true);
    expect((await listClaimCandidates(sq(), tm.makerCtx)).map((c: any) => c.id)).toContain(ids[0]);

    // cancelling is for the builder, before it is verified
    const b: any = await createClaimBatch(sq(), tm.makerCtx, { calculationIds: [ids[1]!] });
    await expect(cancelClaimBatch(sq(), tm.checkerCtx, b.id, "no")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await cancelClaimBatch(sq(), tm.makerCtx, b.id, "Wrong period")).toMatchObject({ status: "cancelled" });
    await expect(cancelClaimBatch(sq(), tm.makerCtx, b.id, "again")).rejects.toThrow(/cannot be cancelled/);
    expect((await listClaimCandidates(sq(), tm.makerCtx)).map((c: any) => c.id)).toContain(ids[1]);

    // the decision log is append-only at the database level
    await expect(sq().query("UPDATE commission_claim_decisions SET reason='tampered' WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);
    await expect(sq().query("DELETE FROM commission_claim_decisions WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);
  });

  it("only one of two people racing for the same commission wins, and the due-date sweep tells releasers once", async () => {
    const t = await makeTenant();
    const { ids } = await approvedCommissions(t, 1);
    const tm = await team(t);
    const second = await makeUser(t, ["finance_officer"]);
    const secondCtx = await stepped(t, second.id);
    const results = await Promise.allSettled([createClaimBatch(sq(), tm.makerCtx, { calculationIds: ids }), createClaimBatch(sq(), secondCtx, { calculationIds: ids })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const { ids: more } = await approvedCommissions(t, 1);
    const b = await batchAt(t, tm, more, "scheduled");
    const { systemContext } = await import("@reales/database");
    const sys = systemContext(t.tenantId, "corr_sweep_claims");
    expect(await claimReleaseDueSweep(sq(), sys)).toBeGreaterThan(0);
    expect(await claimReleaseDueSweep(sq(), sys)).toBe(0); // already told
    expect((await listMyNotifications(sq(), tm.checker.ctx)).some((n: any) => n.kind === "claim.due" && n.entityId === b.id)).toBe(true);
  });
});
