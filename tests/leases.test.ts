import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  activateLease, addAddendum, addDays, addMonths, assignOwnership, attachLeaseDocument, buildRentSchedule, collectDeposit, completeInspection, completeWork, contractTotalMinor, createContact,
  createDocument, createEnvelope, createInspectionTemplate, createLease, createManagementAgreement, createPortfolio, createTicket, createVendor, decideQuotation, deductDeposit,
  generateOwnerStatement, getInspection, getLease, getTicket, issueOwnerStatement, issueWorkOrder, LeaseNotActivatableError, leaseSweep, listLeases, recordRentPayment, refundDeposit, renewLease,
  scheduleInspection, setStorage, LocalObjectStorage, signInspection, startWork, submitQuotation, syncInspection, terminateLease, termMonths, ticketSlaSweep, toMinor, triageTicket, slaReport,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, makeUser, testDb } from "./helpers";
import { makeInventory, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "reales-lease-")); setStorage(new LocalObjectStorage(dir)); });
afterAll(async () => { setStorage(null); rmSync(dir, { recursive: true, force: true }); await closeTestDb(); });

async function pmKit() {
  const t = await makeTenant();
  const org = await makeOrg(t);
  const pm = await makeUser(t, ["property_manager"], { branchId: org.marina.id, businessUnitId: org.bu.id });
  const inv = await makeInventory(t);
  const owner = await createContact(sq(), t.admin, { firstName: "Owner", phone: phone() });
  const tenant = await createContact(sq(), t.admin, { firstName: "Tenant", phone: phone() });
  const portfolio = await createPortfolio(sq(), pm.ctx, { name: "Marina Holdings", ownerContactId: owner.id, branchId: org.marina.id });
  await assignOwnership(sq(), pm.ctx, { unitId: inv.unit.id, portfolioId: portfolio.id, fromDate: "2026-01-01" });
  return { t, org, pm, inv, owner, tenant, portfolio };
}
type K = Awaited<ReturnType<typeof pmKit>>;
const lease = (k: K, o: Record<string, unknown> = {}) =>
  createLease(sq(), k.pm.ctx, { unitId: k.inv.unit.id, startsOn: "2027-01-01", endsOn: "2027-12-31", annualRent: 120_000, installments: 4, tenantContactIds: [k.tenant.id], ...o } as any);

describe("date and schedule maths", () => {
  it("handles month ends and whole-month terms", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(termMonths("2027-01-01", "2027-12-31")).toBe(12);
    expect(termMonths("2027-01-01", "2027-06-30")).toBe(6);
    expect(termMonths("2027-01-01", "2027-12-30")).toBeNull();
  });
  it("reconciles to the fil for awkward amounts and instalment counts", () => {
    for (const [rent, months, n] of [[100_000.01, 12, 3], [99_999.99, 12, 12], [85_000, 7, 4], [1, 3, 3]] as const) {
      const rows = buildRentSchedule("2027-01-31", months, rent, n);
      expect(rows.reduce((a, r) => a + r.amountMinor, 0)).toBe(contractTotalMinor(rent, months));
      expect(rows.map((r) => r.dueDate)).toEqual([...rows.map((r) => r.dueDate)].sort());
      expect(Math.max(...rows.map((r) => r.amountMinor)) - Math.min(...rows.map((r) => r.amountMinor))).toBeLessThanOrEqual(1);
    }
  });
});

describe("ownership", () => {
  it("never lets co-ownership shares exceed 100%", async () => {
    const k = await pmKit();
    const other = await createPortfolio(sq(), k.pm.ctx, { name: "Second", ownerContactId: k.owner.id });
    await expect(assignOwnership(sq(), k.pm.ctx, { unitId: k.inv.unit.id, portfolioId: other.id, sharePct: 10, fromDate: "2026-01-01" })).rejects.toThrow(/maximum 100%/);
    await expect(assignOwnership(sq(), k.pm.ctx, { unitId: k.inv.unit.id, portfolioId: k.portfolio.id, fromDate: "2026-01-01" })).rejects.toThrow(/already owns/);
  });
});

describe("lease creation and occupancy", () => {
  it("builds parties, a reconciling schedule and rejects non-whole-month terms", async () => {
    const k = await pmKit();
    const l = await lease(k, { depositAmount: 5_000 });
    expect(l.status).toBe("draft");
    expect(l.portfolioId).toBe(k.portfolio.id);
    expect(l.schedule).toHaveLength(4);
    expect(l.scheduleTotal).toBe("120000.00");
    expect(l.parties.map((p: any) => p.role).sort()).toEqual(["landlord", "tenant"]);
    expect(l.deposit.status).toBe("pending");
    await expect(lease(k, { startsOn: "2028-01-01", endsOn: "2028-12-30" })).rejects.toThrow(/whole number of months/);
    await expect(lease(k, { startsOn: "2028-01-01", endsOn: "2028-12-31", installments: 5 })).rejects.toThrow(/instalments/);
  });

  it("prevents contradictory occupancy, including under concurrency, and allows back-to-back terms", async () => {
    const k = await pmKit();
    await lease(k);
    await expect(lease(k, { startsOn: "2027-12-31", endsOn: "2028-12-30" })).rejects.toThrow(/already has a lease/);
    await expect(lease(k, { startsOn: "2027-06-01", endsOn: "2027-08-31", installments: 1 })).rejects.toThrow(/already has a lease/);
    await expect(lease(k, { startsOn: "2028-01-01", endsOn: "2028-12-31" })).resolves.toBeTruthy();

    const k2 = await pmKit();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => lease(k2)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listLeases(sq(), k2.pm.ctx, { limit: 50, offset: 0, unitId: k2.inv.unit.id }))).toHaveLength(1);
  });
});

describe("activation gate, rent and deposits", () => {
  it("blocks activation until registration, a SIGNED contract (and deposit when required) exist, then collects rent in due order", async () => {
    const k = await pmKit();
    const l = await lease(k);
    await expect(activateLease(sq(), k.pm.ctx, l.id)).rejects.toBeInstanceOf(LeaseNotActivatableError);
    await expect(activateLease(sq(), k.pm.ctx, l.id)).rejects.toMatchObject({ reasons: expect.arrayContaining([expect.stringMatching(/Ejari/), expect.stringMatching(/No contract/)]) });

    const doc = await createDocument(sq(), k.t.admin, { title: "Tenancy contract", kind: "contract", file: { filename: "lease.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4\n% lease\n%%EOF\n") } });
    await attachLeaseDocument(sq(), k.pm.ctx, l.id, doc.id, "EJARI-123");
    await expect(activateLease(sq(), k.pm.ctx, l.id)).rejects.toMatchObject({ reasons: [expect.stringMatching(/not been signed/)] });

    const env = await createEnvelope(sq(), k.t.admin, { documentId: doc.id, signers: [{ name: "Tenant", email: "tenant@example.test" }] });
    await sq().query("UPDATE signature_envelopes SET status='completed' WHERE id=:id", { replacements: { id: env.id } });
    const active = await activateLease(sq(), k.pm.ctx, l.id);
    expect(active.status).toBe("active");

    // Pay the first instalment and half of the second in a single payment: allocated oldest first.
    const r = await recordRentPayment(sq(), k.pm.ctx, l.id, { amount: 45_000, method: "bank_transfer" });
    expect(r.allocations.map((a) => [a.seq, a.status])).toEqual([[1, "paid"], [2, "partial"]]);
    expect(r.lease.outstanding).toBe("75000.00");
    await expect(recordRentPayment(sq(), k.pm.ctx, l.id, { amount: 80_000, method: "cheque" })).rejects.toThrow(/exceeds the rent owed/);

    // Concurrent payments cannot over-allocate.
    const res = await Promise.allSettled(Array.from({ length: 4 }, () => recordRentPayment(sq(), k.pm.ctx, l.id, { amount: 30_000, method: "bank_transfer" })));
    const ok = res.filter((x) => x.status === "fulfilled").length;
    const final = await getLease(sq(), k.pm.ctx, l.id);
    expect(toMinor(final.paidTotal)).toBe((45_000 + ok * 30_000) * 100);
    expect(toMinor(final.paidTotal)).toBeLessThanOrEqual(toMinor(final.scheduleTotal));
  });

  it("runs the deposit lifecycle with limits, reasons and step-up", async () => {
    const k = await pmKit();
    const l = await lease(k, { depositAmount: 6_000 });
    await collectDeposit(sq(), k.pm.ctx, l.id, { method: "cheque" });
    const stepped = await contextFor(k.t.tenantId, k.pm.id, { stepUp: true });
    await expect(deductDeposit(sq(), k.pm.ctx, l.id, { amount: 100, reason: "damage" })).rejects.toThrow();
    await expect(deductDeposit(sq(), stepped, l.id, { amount: 7_000, reason: "damage" })).rejects.toThrow(/exceeds/);
    await expect(deductDeposit(sq(), stepped, l.id, { amount: 1_000, reason: " " })).rejects.toThrow(/reason/);
    await deductDeposit(sq(), stepped, l.id, { amount: 1_500, reason: "Wall repair" });
    await expect(refundDeposit(sq(), stepped, l.id)).rejects.toThrow(/after the lease has ended/);
  });

  it("terminates a lease, cancels future instalments, then refunds exactly the balance", async () => {
    const k = await pmKit();
    const l = await lease(k, { depositAmount: 4_000 });
    await collectDeposit(sq(), k.pm.ctx, l.id, { method: "bank_transfer" });
    await sq().query("UPDATE leases SET status='active', registration_ref='E1' WHERE id=:id", { replacements: { id: l.id } });
    await expect(terminateLease(sq(), k.pm.ctx, l.id, { effectiveOn: "2026-01-01", reason: "x" })).rejects.toThrow(/inside the lease term/);
    const t = await terminateLease(sq(), k.pm.ctx, l.id, { effectiveOn: "2027-04-30", reason: "Tenant relocating" });
    expect(t.status).toBe("terminated");
    expect(t.schedule.map((r: any) => r.status)).toEqual(["pending", "pending", "cancelled", "cancelled"]);
    const stepped = await contextFor(k.t.tenantId, k.pm.id, { stepUp: true });
    const refunded = await refundDeposit(sq(), stepped, l.id);
    expect(refunded.deposit.status).toBe("released");
    expect(refunded.deposit.held).toBe("0.00");
    // the unit is free again for the cancelled period
    await expect(lease(k, { startsOn: "2027-05-01", endsOn: "2027-12-31" })).resolves.toBeTruthy();
  });

  it("renews with the same parties, no overlap, and enforces a configured increase cap", async () => {
    const k = await pmKit();
    const l = await lease(k);
    await sq().query("UPDATE leases SET status='active' WHERE id=:id", { replacements: { id: l.id } });
    const mgr = await makeUser(k.t, ["property_manager"], { branchId: k.org.marina.id, businessUnitId: k.org.bu.id });
    await sq().query("INSERT INTO tenant_settings (id, tenant_id, `key`, value, created_at, updated_at) VALUES (UUID(), :t, 'lease.max_renewal_increase_pct', '5', NOW(3), NOW(3))", { replacements: { t: k.t.tenantId } });
    await expect(renewLease(sq(), mgr.ctx, l.id, { newAnnualRent: 140_000 })).rejects.toThrow(/exceeds the configured limit/);
    const renewed = await renewLease(sq(), mgr.ctx, l.id, { newAnnualRent: 126_000 });
    expect(renewed.startsOn).toBe("2028-01-01");
    expect(renewed.endsOn).toBe("2028-12-31");
    expect(renewed.previousLeaseId).toBe(l.id);
    expect(renewed.scheduleTotal).toBe("126000.00");
    await expect(renewLease(sq(), mgr.ctx, l.id, { newAnnualRent: 126_000 })).rejects.toThrow(/already been renewed/);
    await addAddendum(sq(), k.pm.ctx, renewed.id, { title: "Parking bay", effectiveOn: "2028-01-01", changes: { parking: 1 } });
  });

  it("sweeps: marks overdue rent once, ends finished leases, raises each expiry notice once", async () => {
    const k = await pmKit();
    const old = await lease(k, { startsOn: "2020-01-01", endsOn: "2020-12-31" });
    await sq().query("UPDATE leases SET status='active' WHERE id=:id", { replacements: { id: old.id } });
    const ctx = { ...k.pm.ctx };
    const first = await leaseSweep(sq(), ctx);
    expect(first.ended).toBeGreaterThanOrEqual(1);
    expect(first.overdueMarked).toBeGreaterThanOrEqual(4);
    const second = await leaseSweep(sq(), ctx);
    expect(second.overdueMarked).toBe(0);
    expect((await getLease(sq(), k.pm.ctx, old.id)).status).toBe("ended");

    const end = addDays(new Date().toISOString().slice(0, 10), 25);
    const soon = await lease(k, { startsOn: addMonths(addDays(end, 1), -12), endsOn: end, annualRent: 12_000, installments: 1 });
    await sq().query("UPDATE leases SET status='active' WHERE id=:id", { replacements: { id: soon.id } });
    const a = await leaseSweep(sq(), ctx);
    const b = await leaseSweep(sq(), ctx);
    expect(a.expiringNotices).toBe(1);
    expect(b.expiringNotices).toBe(0);
  });

  it("is tenant-isolated and permission-checked", async () => {
    const k = await pmKit();
    const l = await lease(k);
    const other = await pmKit();
    await expect(getLease(sq(), other.pm.ctx, l.id)).rejects.toThrow(/not found/i);
    const viewer = await makeUser(k.t, ["viewer"]);
    await expect(lease(k, { startsOn: "2030-01-01", endsOn: "2030-12-31" }).then(() => createLease(sq(), viewer.ctx, { unitId: k.inv.unit.id, startsOn: "2031-01-01", endsOn: "2031-12-31", annualRent: 1, tenantContactIds: [k.tenant.id] }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("maintenance", () => {
  it("runs ticket -> triage -> quote -> approval -> work order -> completion, with a threshold for approvals", async () => {
    const k = await pmKit();
    const coord = await makeUser(k.t, ["maintenance_coordinator"], { branchId: k.org.marina.id, businessUnitId: k.org.bu.id });
    const vendor = await createVendor(sq(), coord.ctx, { name: "CoolAir LLC", categories: ["hvac"] });
    const tk = await createTicket(sq(), coord.ctx, { unitId: k.inv.unit.id, category: "hvac", priority: "urgent", title: "AC not cooling" });
    expect(tk.status).toBe("new");
    expect(new Date(tk.slaDueAt).getTime() - new Date(tk.createdAt).getTime()).toBeLessThanOrEqual(4 * 3_600_000 + 2000);

    await triageTicket(sq(), coord.ctx, tk.id, { assignedUserId: coord.id });
    await submitQuotation(sq(), coord.ctx, tk.id, { vendorId: vendor.id, amount: 2_000 });
    const quoted = await getTicket(sq(), coord.ctx, tk.id);
    expect(quoted.status).toBe("quoted");
    await expect(decideQuotation(sq(), coord.ctx, tk.id, quoted.quotations[0].id, "approved")).rejects.toBeInstanceOf(ForbiddenError); // coordinator lacks maintenance.approve
    await decideQuotation(sq(), k.pm.ctx, tk.id, quoted.quotations[0].id, "approved");

    await issueWorkOrder(sq(), coord.ctx, tk.id, {});
    await startWork(sq(), coord.ctx, tk.id);
    await expect(completeWork(sq(), coord.ctx, tk.id, { finalCost: 3_000 })).rejects.toThrow(/new approval/);
    const done = await completeWork(sq(), coord.ctx, tk.id, { finalCost: 2_100 });
    expect(done.status).toBe("completed");
    expect(done.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(["created", "triaged", "quotation_submitted", "quotation_approved", "work_order_issued", "work_started", "work_completed"]));

    // an owner statement reflects rent and maintenance
    await createManagementAgreement(sq(), k.pm.ctx, { portfolioId: k.portfolio.id, feePct: 5, startsOn: "2026-01-01" });
    const period = new Date().toISOString().slice(0, 7);
    const st = await generateOwnerStatement(sq(), k.pm.ctx, k.portfolio.id, period);
    expect(st.maintenanceCost).toBe("2100.00");
    expect(st.netPayable).toBe("-2100.00");
    const issued = await issueOwnerStatement(sq(), k.pm.ctx, st.id);
    expect(issued.status).toBe("issued");
    await expect(generateOwnerStatement(sq(), k.pm.ctx, k.portfolio.id, period)).rejects.toThrow(/issued/);
  });

  it("measures SLA: a breach is recorded exactly once and reported", async () => {
    const k = await pmKit();
    const tk = await createTicket(sq(), k.pm.ctx, { unitId: k.inv.unit.id, category: "plumbing", priority: "high", title: "Leak" });
    await sq().query("UPDATE maintenance_tickets SET sla_due_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id=:id", { replacements: { id: tk.id } });
    expect(await ticketSlaSweep(sq(), k.pm.ctx)).toBe(1);
    expect(await ticketSlaSweep(sq(), k.pm.ctx)).toBe(0);
    const rep = await slaReport(sq(), k.pm.ctx);
    expect(rep.find((r) => r.priority === "high")).toMatchObject({ total: 1, breached: 1 });
  });
});

describe("inspections and offline sync", () => {
  it("replays are no-ops and stale edits are reported as conflicts instead of overwritten", async () => {
    const k = await pmKit();
    const inspector = await makeUser(k.t, ["inspector"], { branchId: k.org.marina.id, businessUnitId: k.org.bu.id });
    const tpl = await createInspectionTemplate(sq(), k.pm.ctx, { name: "Move-in", kind: "move_in", items: [{ label: "Walls", area: "Living" }, { label: "Kitchen", area: "Kitchen" }] });
    const insp = await scheduleInspection(sq(), k.pm.ctx, { unitId: k.inv.unit.id, kind: "move_in", inspectorUserId: inspector.id, templateId: tpl.id });
    expect(insp.items).toHaveLength(2);
    const [walls, kitchen] = insp.items as any[];

    const m1 = { clientMutationId: "dev1-1", baseVersion: 1, changes: [{ itemId: walls.id, condition: "good" as const }] };
    const r1 = await syncInspection(sq(), inspector.ctx, insp.id, [m1]);
    expect(r1).toMatchObject({ applied: ["dev1-1"], version: 2 });
    const replay = await syncInspection(sq(), inspector.ctx, insp.id, [m1]);
    expect(replay).toMatchObject({ applied: [], duplicates: ["dev1-1"], version: 2 });

    const stale = await syncInspection(sq(), inspector.ctx, insp.id, [{ clientMutationId: "dev2-1", baseVersion: 1, changes: [{ itemId: walls.id, condition: "damaged" }, { itemId: kitchen.id, condition: "fair" }] }]);
    expect(stale.applied).toEqual([]);
    expect(stale.conflicts).toEqual([expect.objectContaining({ itemId: walls.id, serverVersion: 2 })]);
    const fresh = await syncInspection(sq(), inspector.ctx, insp.id, [{ clientMutationId: "dev2-2", baseVersion: 2, changes: [{ itemId: walls.id, condition: "damaged", notes: "crack" }] }]);
    expect(fresh.applied).toEqual(["dev2-2"]);

    const done = await completeInspection(sq(), inspector.ctx, insp.id, { summary: "ok" });
    expect(done.status).toBe("completed");
    await expect(syncInspection(sq(), inspector.ctx, insp.id, [{ clientMutationId: "late", baseVersion: 9, changes: [] }])).rejects.toThrow(/no longer be edited/);
    await signInspection(sq(), inspector.ctx, insp.id, k.tenant.id);
    expect((await getInspection(sq(), inspector.ctx, insp.id)).status).toBe("signed");

    // another inspector (own_records scope) cannot see it
    const other = await makeUser(k.t, ["inspector"], { branchId: k.org.marina.id, businessUnitId: k.org.bu.id });
    await expect(getInspection(sq(), other.ctx, insp.id)).rejects.toThrow(/not found/i);
  });
});
