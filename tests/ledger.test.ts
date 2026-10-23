import { afterAll, describe, expect, it } from "vitest";
import { createContact, createInvoice, issueInvoice, journal, journalCsv, recordPayment, trialBalance, voidInvoice } from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, makeUser, testDb } from "./helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

describe("ledger derived from finance records", () => {
  it("posts invoices, payments and voids as balanced entries, rolls them into a trial balance and exports a safe CSV", async () => {
    const t = await makeTenant();
    const finance = await makeUser(t, ["finance_officer"]);
    const contact = await createContact(sq(), t.admin, { firstName: "=Payer", phone: phone() });
    const mk = async (price: number) => issueInvoice(sq(), finance.ctx, (await createInvoice(sq(), finance.ctx, { contactId: contact.id, lines: [{ description: "Brokerage commission", quantity: 1, unitPrice: price }], dueDate: today() })).id);
    const a: any = await mk(10_000), b: any = await mk(2_000);
    await recordPayment(sq(), finance.ctx, { contactId: contact.id, amount: 4_000, method: "bank_transfer", providerRef: "TRF-1", invoiceId: a.id });
    await recordPayment(sq(), finance.ctx, { contactId: contact.id, amount: 500, method: "cash" }); // not tied to an invoice: customer deposit
    await voidInvoice(sq(), finance.ctx, b.id, "Issued by mistake");

    const range = { from: today(), to: today() };
    const entries = await journal(sq(), t.admin, range);
    for (const e of entries) expect(e.lines.reduce((s, l) => s + l.debit, 0)).toBeCloseTo(e.lines.reduce((s, l) => s + l.credit, 0), 2);
    const inv = entries.find((e) => e.source === "invoice" && e.sourceId === a.id)!;
    expect(inv.lines.find((l) => l.account === "1200")!.debit).toBe(10_500); // 10,000 + 5% VAT
    expect(inv.lines.find((l) => l.account === "4000")!.credit).toBe(10_000);
    expect(inv.lines.find((l) => l.account === "2100")!.credit).toBe(500);
    expect(entries.some((e) => e.source === "invoice_void" && e.sourceId === b.id)).toBe(true);
    const cash = entries.find((e) => e.source === "payment" && e.reference === "TRF-1")!;
    expect(cash.lines.find((l) => l.account === "1100")!.debit).toBe(4_000);
    expect(cash.lines.find((l) => l.account === "1200")!.credit).toBe(4_000);
    const deposit = entries.find((e) => e.source === "payment" && e.lines.some((l) => l.account === "2300"))!;
    expect(deposit.lines.find((l) => l.account === "2300")!.credit).toBe(500);

    const tb = await trialBalance(sq(), t.admin, today());
    const total = tb.totals[0]!;
    expect(total.debit).toBe(total.credit);
    const bal = (code: string) => tb.accounts.find((x) => x.account === code)!.balance;
    expect(bal("1100")).toBe(4_500); // bank
    expect(bal("1200")).toBe(6_500); // receivable: 10,500 - 4,000, the voided invoice nets to nothing
    expect(bal("4000")).toBe(10_000);
    expect(bal("2100")).toBe(500);

    const csv = await journalCsv(sq(), t.admin, range);
    expect(csv.csv.split("\r\n")[0]).toContain("Account code");
    expect(csv.csv).toContain('"1200"');
    expect(csv.filename).toMatch(/^journal-/);

    await expect(journal(sq(), finance.ctx, range).then((x) => x.length)).resolves.toBeGreaterThan(0);
    const agent = await makeUser(t, ["agent"]);
    await expect(journal(sq(), agent.ctx, range)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(journal(sq(), t.admin, { from: "2026-02-01", to: "2026-01-01" })).rejects.toThrow(/valid date range/);
    expect(await journal(sq(), t.admin, { from: "2001-01-01", to: "2001-01-31" })).toEqual([]);
  });
});
