import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  advanceDealStage, applyPaymentEvent, buildMockPaymentWebhook, cancelDeal, completeMilestone, createContact, createInvoice, createPaymentLink, getDeal, getInvoice, getPayment,
  ingestWebhook, issueInvoice, listDealPayments, listInvoices, listPayments, NotFoundError, processWebhookEvent, recordPayment, toMinor, voidInvoice,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, makeUser, testDb } from "./helpers";
import { dateOffset } from "./brokerage-helpers";
import { kit, openDeal, phone } from "./deal-helpers";

afterAll(closeTestDb);
const sq = () => testDb();

async function financeKit() {
  const t = await makeTenant();
  const finance = await makeUser(t, ["finance_officer"]);
  const contact = await createContact(sq(), t.admin, { firstName: "Payer", phone: phone() });
  return { t, finance, contact };
}
async function issued(f: Awaited<ReturnType<typeof financeKit>>, lines = [{ description: "Brokerage commission", quantity: 1, unitPrice: 10_000 }], extra: { dealId?: string } = {}) {
  const inv = await createInvoice(sq(), f.finance.ctx, { contactId: f.contact.id, lines, dueDate: dateOffset(14), ...extra });
  return issueInvoice(sq(), f.finance.ctx, inv.id);
}

describe("invoices", () => {
  it("computes line and VAT totals exactly, numbers invoices sequentially even under concurrency, and freezes issued invoices", async () => {
    const f = await financeKit();
    const inv = await createInvoice(sq(), f.finance.ctx, {
      contactId: f.contact.id, dueDate: dateOffset(10),
      lines: [{ description: "Commission", quantity: 1, unitPrice: 10_000 }, { description: "Admin fee", quantity: 3, unitPrice: 333.33, vatRate: 5 }, { description: "Zero-rated", quantity: 1, unitPrice: 100, vatRate: 0 }],
    });
    expect(inv.status).toBe("draft");
    expect(inv.subtotal).toBe("11099.99"); // 10000 + 999.99 + 100
    expect(inv.vatAmount).toBe("550.00"); // 500 + 50.00 (999.99*5% = 49.9995 -> 50.00) + 0
    expect(inv.total).toBe("11649.99");
    expect(inv.lines.map((l: any) => l.amount)).toEqual(["10000.00", "999.99", "100.00"]);
    expect(inv.outstanding).toBe("11649.99");

    const many = await Promise.all(Array.from({ length: 6 }, () => createInvoice(sq(), f.finance.ctx, { contactId: f.contact.id, lines: [{ description: "x", quantity: 1, unitPrice: 1 }] })));
    const nums = [inv, ...many].map((i) => Number(i.number.split("-")[2])).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7]); // gap-free, no duplicates

    await expect(issueInvoice(sq(), f.finance.ctx, many[0]!.id)).rejects.toThrow(/due date/);
    const ok = await issueInvoice(sq(), f.finance.ctx, inv.id);
    expect(ok.status).toBe("issued");
    await expect(issueInvoice(sq(), f.finance.ctx, inv.id)).rejects.toThrow(/cannot be issued/);
  });

  it("validates input, restricts who can manage/see invoices, and never crosses tenants", async () => {
    const f = await financeKit();
    await expect(createInvoice(sq(), f.finance.ctx, { contactId: f.contact.id, lines: [] })).rejects.toThrow(/at least one line/);
    await expect(createInvoice(sq(), f.finance.ctx, { contactId: f.contact.id, lines: [{ description: "x", quantity: 0, unitPrice: 5 }] })).rejects.toThrow(/positive/);
    await expect(createInvoice(sq(), f.finance.ctx, { contactId: f.contact.id, lines: [{ description: "x", quantity: 1, unitPrice: 5, vatRate: 150 }] })).rejects.toThrow(/VAT/);
    const agent = await makeUser(f.t, ["agent"]);
    await expect(createInvoice(sq(), agent.ctx, { contactId: f.contact.id, lines: [{ description: "x", quantity: 1, unitPrice: 5 }] })).rejects.toBeInstanceOf(ForbiddenError);
    const inv = await issued(f);
    await expect(getInvoice(sq(), agent.ctx, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
    const other = await makeTenant();
    await expect(getInvoice(sq(), other.admin, inv.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listInvoices(sq(), other.admin, { limit: 10, offset: 0 })).toEqual([]);
    await expect(createInvoice(sq(), other.admin, { contactId: f.contact.id, lines: [{ description: "x", quantity: 1, unitPrice: 5 }] })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("payments and allocation", () => {
  it("allocates to invoices, updates status, issues numbered receipts and handles overpayment and duplicates", async () => {
    const f = await financeKit();
    const inv = await issued(f);
    const p1 = await recordPayment(sq(), f.finance.ctx, { contactId: f.contact.id, amount: 4_000, method: "bank_transfer", providerRef: "TRF-1", invoiceId: inv.id });
    expect(p1.status).toBe("succeeded");
    expect(p1.receipt.number).toMatch(/^RCT-\d{4}-000001$/);
    expect((await getInvoice(sq(), f.finance.ctx, inv.id))).toMatchObject({ status: "partially_paid", paid: "4000.00", outstanding: "6500.00" });

    const p2 = await recordPayment(sq(), f.finance.ctx, { contactId: f.contact.id, amount: 7_000, method: "cheque", invoiceId: inv.id }); // 500 more than owed
    expect(p2.allocations.map((a: any) => a.amount)).toEqual(["6500.00"]); // the surplus 500 stays unallocated
    expect(await getInvoice(sq(), f.finance.ctx, inv.id)).toMatchObject({ status: "paid", outstanding: "0.00" });
    await expect(recordPayment(sq(), f.finance.ctx, { contactId: f.contact.id, amount: 100, method: "cash", invoiceId: inv.id })).rejects.toThrow(/cannot receive payments/);
    await expect(recordPayment(sq(), f.finance.ctx, { contactId: f.contact.id, amount: 50, method: "bank_transfer", providerRef: "TRF-1" })).rejects.toThrow(/already recorded/);
    await expect(recordPayment(sq(), f.finance.ctx, { contactId: f.contact.id, amount: -5, method: "cash" })).rejects.toThrow(/positive/);
    await expect(voidInvoice(sq(), f.finance.ctx, inv.id, "oops")).rejects.toThrow(/payments allocated/);
    await expect(sq().query("UPDATE payment_allocations SET amount=1 WHERE tenant_id=:t", { replacements: { t: f.t.tenantId } })).rejects.toThrow(/append-only/);

    // The same bank reference is fine in a different tenant
    const g = await financeKit();
    await expect(recordPayment(sq(), g.finance.ctx, { contactId: g.contact.id, amount: 10, method: "bank_transfer", providerRef: "TRF-1" })).resolves.toBeTruthy();
    expect((await listPayments(sq(), f.finance.ctx, { limit: 10, offset: 0 })).length).toBe(2);
  });

  it("never over-allocates an invoice when payments arrive concurrently", async () => {
    const f = await financeKit();
    const inv = await issued(f); // 10,500 incl. VAT
    const total = toMinor(inv.total);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => recordPayment(sq(), f.finance.ctx, { contactId: f.contact.id, amount: 3_000, method: "bank_transfer", invoiceId: inv.id })));
    expect(results.every((r) => r.status === "fulfilled" || /cannot receive payments/.test(String((r as any).reason?.message)))).toBe(true);
    const [row] = await sq().query<{ s: string }>("SELECT COALESCE(SUM(amount),0) s FROM payment_allocations WHERE tenant_id=:t AND invoice_id=:i", { replacements: { t: f.t.tenantId, i: inv.id }, type: QueryTypes.SELECT });
    expect(toMinor(row!.s)).toBe(total); // exactly the invoice total, never more
    expect((await getInvoice(sq(), f.finance.ctx, inv.id)).status).toBe("paid");
  });

  it("checks contacts and currencies on allocation, voids unpaid invoices with a reason, and restricts payment recording", async () => {
    const f = await financeKit();
    const inv = await issued(f);
    const stranger = await createContact(sq(), f.t.admin, { firstName: "Someone else", phone: phone() });
    await expect(recordPayment(sq(), f.finance.ctx, { contactId: stranger.id, amount: 100, method: "cash", invoiceId: inv.id })).rejects.toThrow(/different contacts/);
    await expect(recordPayment(sq(), f.finance.ctx, { contactId: f.contact.id, amount: 100, method: "cash", currency: "USD", invoiceId: inv.id })).rejects.toThrow(/Currency mismatch/);
    const agent = await makeUser(f.t, ["agent"]);
    await expect(recordPayment(sq(), agent.ctx, { contactId: f.contact.id, amount: 1, method: "cash" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(voidInvoice(sq(), f.finance.ctx, inv.id, " ")).rejects.toThrow(/reason/);
    expect((await voidInvoice(sq(), f.finance.ctx, inv.id, "issued to the wrong contact")).status).toBe("void");
    await expect(recordPayment(sq(), f.finance.ctx, { contactId: f.contact.id, amount: 100, method: "cash", invoiceId: inv.id })).rejects.toThrow(/cannot receive payments/);
    const audit = await sq().query<{ action: string }>("SELECT action FROM audit_events WHERE tenant_id=:t AND action IN ('invoice.issued','invoice.voided')", { replacements: { t: f.t.tenantId }, type: QueryTypes.SELECT });
    expect(audit.map((a) => a.action).sort()).toEqual(["invoice.issued", "invoice.voided"]);
  });
});

describe("payments and deals", () => {
  it("completes the deposit milestone when the payment covers it, and blocks cancelling a paid deal", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const finance = await makeUser(t, ["finance_officer"]);
    const { deal } = await openDeal(t, k); // deposit milestone = 100,000
    const d0 = await getDeal(sq(), k.mgr.ctx, deal.id);
    const deposit = d0.milestones.find((m: any) => m.key === "deposit");
    const small = await recordPayment(sq(), finance.ctx, { contactId: k.contact.id, amount: 40_000, method: "bank_transfer", dealId: deal.id, milestoneId: deposit.id });
    expect(small.status).toBe("succeeded");
    expect((await getDeal(sq(), k.mgr.ctx, deal.id)).milestones.find((m: any) => m.key === "deposit").status).toBe("pending"); // partial
    await recordPayment(sq(), finance.ctx, { contactId: k.contact.id, amount: 100_000, method: "bank_transfer", dealId: deal.id, milestoneId: deposit.id });
    const d1 = await getDeal(sq(), k.mgr.ctx, deal.id);
    const m = d1.milestones.find((x: any) => x.key === "deposit");
    expect(m.status).toBe("done");
    expect(m.completedBy).toMatch(/^payment:/);
    expect((await advanceDealStage(sq(), k.agent.ctx, deal.id, { to: "contract" })).stage).toBe("contract"); // gate satisfied by evidence, no manual override
    expect((await listDealPayments(sq(), k.agent.ctx, deal.id)).length).toBe(2);
    await expect(listDealPayments(sq(), k.other.ctx, deal.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelDeal(sq(), k.mgr.ctx, deal.id, "buyer withdrew")).rejects.toThrow(/refund/);
    void completeMilestone;
  });
});

describe("payment provider webhooks", () => {
  async function pending(f: Awaited<ReturnType<typeof financeKit>>, amount = 10_500) {
    const inv = await issued(f);
    const link = await createPaymentLink(sq(), f.finance.ctx, { contactId: f.contact.id, amount, invoiceId: inv.id });
    return { inv, link };
  }
  const deliver = async (w: { rawBody: string; headers: Record<string, string> }) => {
    const r = await ingestWebhook(sq(), { kind: "payment", provider: "mock", rawBody: w.rawBody, headers: w.headers });
    return { ingest: r, processed: r.id && r.status === "queued" ? await processWebhookEvent(sq(), r.id) : null };
  };

  it("settles the invoice from a signed callback exactly once, however many times it is redelivered", async () => {
    const f = await financeKit();
    const { inv, link } = await pending(f);
    expect(link.checkoutUrl).toContain(link.providerRef);
    expect((await getPayment(sq(), f.finance.ctx, link.paymentId)).status).toBe("pending");

    const ok = buildMockPaymentWebhook({ type: "payment.succeeded", providerRef: link.providerRef, amount: 10_500, eventId: "evt-pay-1" });
    const first = await deliver(ok);
    expect(first.ingest.status).toBe("queued");
    expect(first.processed).toMatchObject({ status: "processed", outcome: "succeeded" });
    const dup = await deliver(ok);
    expect(dup.ingest).toMatchObject({ duplicate: true, status: "duplicate" });
    const again = await deliver(buildMockPaymentWebhook({ type: "payment.succeeded", providerRef: link.providerRef, amount: 10_500, eventId: "evt-pay-2" })); // provider retry with a new event id
    expect(again.processed).toMatchObject({ status: "processed", outcome: "ignored" });

    const p = await getPayment(sq(), f.finance.ctx, link.paymentId);
    expect(p).toMatchObject({ status: "succeeded" });
    expect(p.receipt.number).toMatch(/^RCT-/);
    expect(p.allocations).toHaveLength(1);
    expect(await getInvoice(sq(), f.finance.ctx, inv.id)).toMatchObject({ status: "paid", outstanding: "0.00" });
    const receipts = await sq().query<{ n: number }>("SELECT COUNT(*) n FROM receipts WHERE tenant_id=:t", { replacements: { t: f.t.tenantId }, type: QueryTypes.SELECT });
    expect(Number(receipts[0]!.n)).toBe(1);
  });

  it("never accepts a callback with a different amount, and records declines", async () => {
    const f = await financeKit();
    const a = await pending(f);
    const bad = await deliver(buildMockPaymentWebhook({ type: "payment.succeeded", providerRef: a.link.providerRef, amount: 1, eventId: "evt-mismatch" }));
    expect(bad.processed).toMatchObject({ status: "processed", outcome: "amount_mismatch" });
    const p = await getPayment(sq(), f.finance.ctx, a.link.paymentId);
    expect(p.status).toBe("failed");
    expect(p.failureReason).toMatch(/amount mismatch/);
    expect((await getInvoice(sq(), f.finance.ctx, a.inv.id)).status).toBe("issued"); // untouched

    const b = await pending(f);
    const declined = await deliver(buildMockPaymentWebhook({ type: "payment.failed", providerRef: b.link.providerRef, amount: 10_500, failureReason: "insufficient funds", eventId: "evt-declined" }));
    expect(declined.processed).toMatchObject({ outcome: "failed" });
    expect((await getPayment(sq(), f.finance.ctx, b.link.paymentId)).failureReason).toBe("insufficient funds");
  });

  it("rejects unsigned callbacks, ignores unknown references and keeps each tenant's payments separate", async () => {
    const f = await financeKit();
    const { link } = await pending(f);
    const w = buildMockPaymentWebhook({ type: "payment.succeeded", providerRef: link.providerRef, amount: 10_500 });
    await expect(ingestWebhook(sq(), { kind: "payment", provider: "mock", rawBody: w.rawBody, headers: {} })).rejects.toMatchObject({ name: "WebhookSignatureError" });
    expect((await deliver(buildMockPaymentWebhook({ type: "payment.succeeded", providerRef: "mock_pay_unknown", amount: 5 }))).ingest.status).toBe("ignored");

    const other = await financeKit();
    const otherPending = await pending(other);
    await deliver(buildMockPaymentWebhook({ type: "payment.succeeded", providerRef: otherPending.link.providerRef, amount: 10_500 }));
    expect((await getPayment(sq(), f.finance.ctx, link.paymentId)).status).toBe("pending"); // other tenant's callback did not touch it
    await expect(getPayment(sq(), other.finance.ctx, link.paymentId)).rejects.toBeInstanceOf(NotFoundError);
    void applyPaymentEvent;
  });
});
