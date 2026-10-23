import { Op, QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { ForbiddenError } from "@reales/rbac";
import { ConflictError, withUow } from "./uow";

/**
 * A general ledger derived from the finance records, for the accountant. Nothing is stored twice: every journal line is computed from an invoice, a payment,
 * a commission or a payout, so it can never disagree with the screens, and each entry carries the id of the record it came from. The same entries can be
 * exported as a journal CSV to import into Odoo, Zoho Books, QuickBooks or Xero, and rolled up into a trial balance. Every entry balances; the code refuses to
 * produce one that does not. Posting rules (account codes are fixed for now):
 *   invoice issued      Dr 1200 receivable (total)          Cr 4000 income (subtotal), Cr 2100 VAT payable (VAT)
 *   invoice voided      the same entry reversed on the void date
 *   payment received    Dr 1100 bank (amount)               Cr 1200 receivable (amount applied to invoices), Cr 2300 customer deposits (the rest)
 *   commission approved Dr 5000 commission expense (net), Dr 1300 VAT recoverable (VAT)   Cr 2200 commission payable (total)
 *   commission paid     Dr 2200 commission payable (total)  Cr 1100 bank (total)
 */
export const ACCOUNTS: Record<string, { name: string; type: "asset" | "liability" | "income" | "expense" }> = {
  "1100": { name: "Bank and cash", type: "asset" }, "1200": { name: "Accounts receivable", type: "asset" }, "1300": { name: "VAT recoverable", type: "asset" },
  "2100": { name: "VAT payable", type: "liability" }, "2200": { name: "Commission payable", type: "liability" }, "2300": { name: "Customer deposits and unapplied receipts", type: "liability" },
  "4000": { name: "Sales and service income", type: "income" }, "5000": { name: "Commission expense", type: "expense" },
};

export interface JournalLine { account: string; accountName: string; debit: number; credit: number }
export interface JournalEntry { date: string; source: "invoice" | "invoice_void" | "payment" | "commission" | "commission_payout"; sourceId: string; reference: string; memo: string; currency: string; lines: JournalLine[] }

const r2 = (n: number) => Math.round(n * 100) / 100;
const day = (d: unknown) => new Date(new Date(d as string).getTime() + 4 * 3_600_000).toISOString().slice(0, 10); // Dubai calendar date
const line = (account: string, debit: number, credit: number): JournalLine => ({ account, accountName: ACCOUNTS[account]!.name, debit: r2(debit), credit: r2(credit) });

function entry(e: Omit<JournalEntry, "lines">, lines: JournalLine[]): JournalEntry | null {
  const kept = lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  if (!kept.length) return null;
  const d = r2(kept.reduce((a, l) => a + l.debit, 0)), c = r2(kept.reduce((a, l) => a + l.credit, 0));
  if (d !== c) throw new Error(`Unbalanced journal entry for ${e.reference}: debit ${d}, credit ${c}`);
  return { ...e, lines: kept };
}

function requireAccountant(ctx: RequestContext) {
  if (!ctx.grants.some((g) => g.permission === "finance.read" && g.scope === "tenant")) throw new ForbiddenError("The ledger needs tenant-wide finance access");
}

export async function journal(sq: Sequelize, ctx: RequestContext, range: { from: string; to: string }): Promise<JournalEntry[]> {
  requireAccountant(ctx);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to) || range.to < range.from) throw new ConflictError("Choose a valid date range");
  if ((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 > 800) throw new ConflictError("Choose at most about two years at a time");
  const from = new Date(`${range.from}T00:00:00+04:00`), to = new Date(`${range.to}T23:59:59.999+04:00`);
  return withUow(sq, ctx, async (u) => {
    const out: JournalEntry[] = [];
    const push = (e: JournalEntry | null) => { if (e && e.date >= range.from && e.date <= range.to) out.push(e); };
    // invoices (issued or later), and their voiding
    for (const i of (await u.repo("Invoice").findAll({ where: { issuedAt: { [Op.ne]: null, [Op.lte]: to }, status: { [Op.ne]: "draft" } }, transaction: u.tx })) as any[]) {
      const sub = Number(i.get("subtotal")), vat = Number(i.get("vatAmount")), tot = Number(i.get("total")), cur = i.get("currency") as string;
      const base = { source: "invoice" as const, sourceId: i.get("id") as string, reference: i.get("number") as string, currency: cur };
      push(entry({ ...base, date: day(i.get("issuedAt")), memo: `Invoice ${i.get("number")} issued` }, [line("1200", tot, 0), line("4000", 0, sub), line("2100", 0, vat)]));
      if (i.get("status") === "void" && i.get("voidedAt")) push(entry({ ...base, source: "invoice_void", date: day(i.get("voidedAt")), memo: `Invoice ${i.get("number")} voided` }, [line("1200", 0, tot), line("4000", sub, 0), line("2100", vat, 0)]));
    }
    // payments received
    const pays = (await u.repo("Payment").findAll({ where: { status: "succeeded", receivedAt: { [Op.ne]: null, [Op.lte]: to } }, transaction: u.tx })) as any[];
    const allocs = pays.length ? ((await u.sq.query("SELECT payment_id, COALESCE(SUM(amount),0) AS n FROM payment_allocations WHERE tenant_id=:t GROUP BY payment_id", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT })) as { payment_id: string; n: string }[]) : [];
    const applied = new Map(allocs.map((a) => [a.payment_id, Number(a.n)]));
    for (const p of pays) {
      const amt = Number(p.get("amount")), toInvoices = Math.min(amt, applied.get(p.get("id")) ?? (p.get("invoiceId") ? amt : 0));
      push(entry({ source: "payment", sourceId: p.get("id"), reference: String(p.get("providerRef") ?? p.get("id")).slice(0, 40), date: day(p.get("receivedAt")), currency: p.get("currency"), memo: `Payment received by ${String(p.get("method")).replace("_", " ")}` }, [line("1100", amt, 0), line("1200", 0, toInvoices), line("2300", 0, amt - toInvoices)]));
    }
    // commissions
    for (const c of (await u.repo("CommissionCalculation").findAll({ where: { status: "approved", approvedAt: { [Op.ne]: null, [Op.lte]: to } }, transaction: u.tx })) as any[]) {
      const net = Number(c.get("commissionAmount")), vat = Number(c.get("vatAmount") ?? 0), cur = c.get("currency") as string, ref = `COM-${String(c.get("id")).slice(0, 8)}`;
      push(entry({ source: "commission", sourceId: c.get("id"), reference: ref, date: day(c.get("approvedAt")), currency: cur, memo: "Commission approved" }, [line("5000", net, 0), line("1300", vat, 0), line("2200", 0, net + vat)]));
      if (c.get("paidAt")) push(entry({ source: "commission_payout", sourceId: c.get("id"), reference: String(c.get("paidReference") ?? ref).slice(0, 40), date: day(c.get("paidAt")), currency: cur, memo: "Commission paid" }, [line("2200", net + vat, 0), line("1100", 0, net + vat)]));
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));
  });
}

/** Balances of every account as at a date, per currency. Debits minus credits for assets and expenses, credits minus debits for liabilities and income. */
export async function trialBalance(sq: Sequelize, ctx: RequestContext, asOf: string) {
  const entries = await journal(sq, ctx, { from: "2000-01-01", to: asOf });
  const rows = new Map<string, { currency: string; account: string; debit: number; credit: number }>();
  for (const e of entries) for (const l of e.lines) {
    const k = `${e.currency}|${l.account}`, r = rows.get(k) ?? { currency: e.currency, account: l.account, debit: 0, credit: 0 };
    r.debit = r2(r.debit + l.debit); r.credit = r2(r.credit + l.credit); rows.set(k, r);
  }
  const accounts = [...rows.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.account.localeCompare(b.account)).map((r) => {
    const a = ACCOUNTS[r.account]!, normalDebit = a.type === "asset" || a.type === "expense";
    return { ...r, name: a.name, type: a.type, balance: r2(normalDebit ? r.debit - r.credit : r.credit - r.debit) };
  });
  const totals = [...new Set(accounts.map((a) => a.currency))].map((currency) => ({ currency, debit: r2(accounts.filter((a) => a.currency === currency).reduce((s, a) => s + a.debit, 0)), credit: r2(accounts.filter((a) => a.currency === currency).reduce((s, a) => s + a.credit, 0)) }));
  return { asOf, accounts, totals, entries: entries.length };
}

/** One CSV row per journal line, the shape accounting packages accept for a manual journal import. Formula-looking text is neutralised. */
export async function journalCsv(sq: Sequelize, ctx: RequestContext, range: { from: string; to: string }) {
  const entries = await journal(sq, ctx, range);
  const cell = (v: string | number) => { const s = String(v); return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };
  const rows = [["Date", "Entry", "Source", "Reference", "Account code", "Account", "Debit", "Credit", "Currency", "Memo"]];
  entries.forEach((e, i) => { for (const l of e.lines) rows.push([e.date, `JE-${String(i + 1).padStart(5, "0")}`, e.source, e.reference, l.account, l.accountName, l.debit.toFixed(2), l.credit.toFixed(2), e.currency, e.memo]); });
  return { filename: `journal-${range.from}-to-${range.to}.csv`, csv: rows.map((r) => r.map(cell).join(",")).join("\r\n") };
}
