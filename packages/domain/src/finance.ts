import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, RequestContext, systemContext } from "@reales/database";
import { authorize, hasPermission, ForbiddenError } from "@reales/rbac";
import { completeMilestoneInUow, DEAL_SCOPE } from "./deals";
import { fromMinor, toMinor, vatOf } from "./money";
import { getPaymentProvider, PaymentWebhookEvent } from "./providers";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const INVOICE_SCOPE: ScopeColumns = { branch: "branchId" };

/**
 * Default VAT rate for brokerage/commission lines. Tax treatment differs by supply (e.g. some property supplies are exempt or
 * zero-rated): finance must confirm the rate per line - it is always an explicit input on each invoice line.
 */
export const DEFAULT_VAT_PCT = 5;

/** Atomic, gap-free per-tenant sequence (row-locked until the surrounding transaction commits). */
export async function nextCounter(u: Uow, tenantId: string, key: string): Promise<number> {
  await u.sq.query(
    "INSERT INTO counters (tenant_id, counter_key, value) VALUES (:t, :k, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)",
    { replacements: { t: tenantId, k: key }, transaction: u.tx },
  );
  const [row] = await u.sq.query<{ v: string }>("SELECT LAST_INSERT_ID() AS v", { transaction: u.tx, type: QueryTypes.SELECT });
  return Number(row!.v);
}

const num = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, "0")}`;

export interface InvoiceLineInput { description: string; quantity: number; unitPrice: number; vatRate?: number }
export interface CreateInvoiceInput { contactId: string; dealId?: string; dueDate?: string; currency?: string; lines: InvoiceLineInput[] }

export async function createInvoice(sq: Sequelize, ctx: RequestContext, i: CreateInvoiceInput) {
  authorize(ctx, "finance.manage");
  if (!i.lines.length) throw new ConflictError("An invoice needs at least one line");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Contact").findById(i.contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    let branchId: string | null = ctx.membership.branchIds[0] ?? null;
    if (i.dealId) {
      const d: any = await u.repo("Deal").findById(i.dealId, { transaction: u.tx });
      if (!d) throw new NotFoundError("Deal");
      branchId = d.get("branchId") ?? branchId;
    }
    let subtotal = 0, vat = 0;
    const lines = i.lines.map((l, idx) => {
      if (!(l.quantity > 0) || !(l.unitPrice >= 0)) throw new ConflictError("Line quantity must be positive and price non-negative");
      const rate = l.vatRate ?? DEFAULT_VAT_PCT;
      if (rate < 0 || rate > 100) throw new ConflictError("Invalid VAT rate");
      const amount = Math.round(l.quantity * toMinor(l.unitPrice));
      const v = vatOf(amount, rate);
      subtotal += amount; vat += v;
      return { idx, l, rate, amount, v };
    });
    const id = randomUUID();
    const n = await nextCounter(u, ctx.tenantId, "invoice");
    await u.repo("Invoice").create({
      id, number: num(`INV-${new Date().getUTCFullYear()}`, n), dealId: i.dealId ?? null, contactId: i.contactId, branchId, status: "draft", currency: i.currency ?? "AED",
      subtotal: fromMinor(subtotal), vatAmount: fromMinor(vat), total: fromMinor(subtotal + vat), dueDate: i.dueDate ?? null, createdBy: ctx.userId,
    }, { transaction: u.tx });
    for (const x of lines) {
      await u.repo("InvoiceLine").create({
        id: randomUUID(), invoiceId: id, description: x.l.description, quantity: x.l.quantity, unitPrice: x.l.unitPrice, vatRate: x.rate, amount: fromMinor(x.amount), vatAmount: fromMinor(x.v), sortOrder: x.idx,
      }, { transaction: u.tx });
    }
    return getInvoiceInUow(u, ctx, id);
  });
}

async function scopedInvoice(u: Uow, ctx: RequestContext, id: string) {
  const scope = await scopeWhere(u, ctx, "finance.read", INVOICE_SCOPE);
  const inv: any = await u.repo("Invoice").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!inv) throw new NotFoundError("Invoice");
  return inv;
}

async function paidMinor(u: Uow, invoiceId: string): Promise<number> {
  const rows = (await u.repo("PaymentAllocation").findAll({ where: { invoiceId }, transaction: u.tx })) as any[];
  return rows.reduce((a, r) => a + toMinor(r.get("amount")), 0);
}

async function getInvoiceInUow(u: Uow, ctx: RequestContext, id: string) {
  const inv = await scopedInvoice(u, ctx, id);
  const [lines, allocs] = await Promise.all([
    u.repo("InvoiceLine").findAll({ where: { invoiceId: id }, order: [["sortOrder", "ASC"]], transaction: u.tx }),
    u.repo("PaymentAllocation").findAll({ where: { invoiceId: id }, transaction: u.tx }),
  ]);
  const paid = (allocs as any[]).reduce((a, r) => a + toMinor(r.get("amount")), 0);
  return { ...plain(inv), lines: lines.map(plain), allocations: allocs.map(plain), paid: fromMinor(paid), outstanding: fromMinor(toMinor(inv.get("total")) - paid) };
}

export async function getInvoice(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, (u) => getInvoiceInUow(u, ctx, id));
}

export async function listInvoices(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string; contactId?: string }) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "finance.read", INVOICE_SCOPE)];
    if (f.status) and.push({ status: f.status });
    if (f.contactId) and.push({ contactId: f.contactId });
    return (await u.repo("Invoice").findAll({ where: { [Op.and]: and }, order: [["createdAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}

/** Issued invoices are immutable: numbers, lines and totals are fixed; corrections are a void plus a new invoice. */
export async function issueInvoice(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "finance.manage");
  return withUow(sq, ctx, async (u) => {
    const inv = await scopedInvoice(u, ctx, id);
    if (inv.get("status") !== "draft") throw new ConflictError(`A ${inv.get("status")} invoice cannot be issued`);
    if (!inv.get("dueDate")) throw new ConflictError("A due date is required before issuing");
    await u.repo("Invoice").updateById(id, { status: "issued", issuedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "invoice.issued", entityType: "invoice", entityId: id, after: { number: inv.get("number"), total: inv.get("total") } });
    await u.emit({ type: "invoice.issued", aggregateType: "invoice", aggregateId: id, payload: { number: inv.get("number"), total: inv.get("total") } });
    return getInvoiceInUow(u, ctx, id);
  });
}

export async function voidInvoice(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  authorize(ctx, "finance.manage");
  if (!reason?.trim()) throw new ConflictError("A reason is required");
  return withUow(sq, ctx, async (u) => {
    const inv = await scopedInvoice(u, ctx, id);
    if (inv.get("status") === "void") throw new ConflictError("Already void");
    await u.sq.query("SELECT id FROM invoices WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id, t: ctx.tenantId }, transaction: u.tx });
    if ((await paidMinor(u, id)) > 0) throw new ConflictError("An invoice with payments allocated cannot be voided");
    await u.repo("Invoice").updateById(id, { status: "void", voidedAt: new Date(), voidReason: reason.trim() }, { transaction: u.tx });
    await u.audit({ action: "invoice.voided", entityType: "invoice", entityId: id, before: { status: inv.get("status"), number: inv.get("number") }, reason: reason.trim() });
    return getInvoiceInUow(u, ctx, id);
  });
}

// ---------------------------------------------------------------- payments
async function allocate(u: Uow, ctx: RequestContext, payment: any, invoiceId: string, requestedMinor: number | null): Promise<number> {
  // Lock the invoice so two concurrent payments cannot both allocate the last of its balance (re-entrant: usually already held).
  await lockInvoice(u, ctx, invoiceId);
  const inv: any = await u.repo("Invoice").findById(invoiceId, { transaction: u.tx });
  if (!inv) throw new NotFoundError("Invoice");
  if (!["issued", "partially_paid"].includes(inv.get("status"))) throw new ConflictError(`A ${inv.get("status")} invoice cannot receive payments`);
  if (inv.get("contactId") !== payment.get("contactId")) throw new ConflictError("The payment and the invoice belong to different contacts");
  if (inv.get("currency") !== payment.get("currency")) throw new ConflictError("Currency mismatch between payment and invoice");
  const already = (await u.repo("PaymentAllocation").findAll({ where: { paymentId: payment.get("id") }, transaction: u.tx })) as any[];
  const usedByPayment = already.reduce((a, r) => a + toMinor(r.get("amount")), 0);
  const outstanding = toMinor(inv.get("total")) - (await paidMinor(u, invoiceId));
  const room = toMinor(payment.get("amount")) - usedByPayment;
  const amount = Math.min(requestedMinor ?? outstanding, outstanding, room);
  if (requestedMinor !== null && requestedMinor > Math.min(outstanding, room)) throw new ConflictError("The allocation exceeds the invoice balance or the payment amount");
  if (amount <= 0) return 0;
  await u.repo("PaymentAllocation").create({ id: randomUUID(), paymentId: payment.get("id"), invoiceId, amount: fromMinor(amount), createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
  const settled = outstanding - amount === 0;
  await u.repo("Invoice").updateById(invoiceId, { status: settled ? "paid" : "partially_paid" }, { transaction: u.tx });
  await u.emit({ type: settled ? "invoice.paid" : "invoice.partially_paid", aggregateType: "invoice", aggregateId: invoiceId, payload: { paymentId: payment.get("id"), amount: fromMinor(amount) } });
  return amount;
}

async function lockInvoice(u: Uow, ctx: RequestContext, invoiceId: string) {
  await u.sq.query("SELECT id FROM invoices WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: invoiceId, t: ctx.tenantId }, transaction: u.tx });
}

async function finalizeSuccess(u: Uow, ctx: RequestContext, payment: any, receivedAt: Date) {
  if (payment.get("invoiceId")) await lockInvoice(u, ctx, payment.get("invoiceId")); // invoice before counters, always
  await u.repo("Payment").updateById(payment.get("id"), { status: "succeeded", receivedAt }, { transaction: u.tx });
  const n = await nextCounter(u, ctx.tenantId, "receipt");
  await u.repo("Receipt").create({ id: randomUUID(), paymentId: payment.get("id"), number: num(`RCT-${new Date().getUTCFullYear()}`, n), issuedAt: mysqlDate(new Date()) }, { transaction: u.tx });
  if (payment.get("invoiceId")) await allocate(u, ctx, payment, payment.get("invoiceId"), null);
  if (payment.get("milestoneId") && payment.get("dealId")) {
    const m: any = await u.repo("DealMilestone").findById(payment.get("milestoneId"), { transaction: u.tx });
    if (m && m.get("dealId") === payment.get("dealId") && (m.get("amount") == null || toMinor(payment.get("amount")) >= toMinor(m.get("amount")))) {
      await completeMilestoneInUow(u, payment.get("dealId"), m.get("key"), `payment:${payment.get("id")}`, { paymentId: payment.get("id") });
    }
  }
  await u.audit({ action: "payment.received", entityType: "payment", entityId: payment.get("id"), after: { amount: payment.get("amount"), method: payment.get("method"), dealId: payment.get("dealId") } });
  await u.emit({ type: "payment.received", aggregateType: "payment", aggregateId: payment.get("id"), payload: { amount: payment.get("amount"), contactId: payment.get("contactId"), dealId: payment.get("dealId") } });
}

export interface RecordPaymentInput {
  contactId: string; amount: number; method: "card" | "bank_transfer" | "cheque" | "cash"; currency?: string;
  providerRef?: string; dealId?: string; milestoneId?: string; invoiceId?: string; receivedAt?: string;
}

/** A payment already received outside the platform (bank transfer, cheque, cash). Created as succeeded, with receipt and allocation. */
export async function recordPayment(sq: Sequelize, ctx: RequestContext, i: RecordPaymentInput) {
  authorize(ctx, "payment.record");
  if (!(i.amount > 0)) throw new ConflictError("Payment amount must be positive");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Contact").findById(i.contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    if (i.dealId && !(await u.repo("Deal").findById(i.dealId, { transaction: u.tx }))) throw new NotFoundError("Deal");
    if (i.milestoneId && !(await u.repo("DealMilestone").findById(i.milestoneId, { transaction: u.tx }))) throw new NotFoundError("Milestone");
    // Lock order is always invoice -> payment -> counters. Inserting the payment first would take a shared FK lock on the
    // invoice row that a later FOR UPDATE could not upgrade without deadlocking concurrent payments.
    if (i.invoiceId) await lockInvoice(u, ctx, i.invoiceId);
    const id = randomUUID();
    try {
      await u.repo("Payment").create({
        id, contactId: i.contactId, dealId: i.dealId ?? null, milestoneId: i.milestoneId ?? null, invoiceId: i.invoiceId ?? null, amount: i.amount, currency: i.currency ?? "AED",
        method: i.method, provider: "manual", providerRef: i.providerRef ?? null, status: "pending", createdBy: ctx.userId,
      }, { transaction: u.tx });
    } catch (e: any) {
      if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") throw new ConflictError("A payment with this reference was already recorded");
      throw e;
    }
    const p = await u.repo("Payment").findById(id, { transaction: u.tx });
    await finalizeSuccess(u, ctx, p, i.receivedAt ? new Date(i.receivedAt) : new Date());
    return getPaymentInUow(u, id);
  });
}

/** Provider-hosted checkout: a pending payment that only becomes real when the provider's signed callback arrives. */
export async function createPaymentLink(sq: Sequelize, ctx: RequestContext, i: { contactId: string; amount: number; currency?: string; invoiceId?: string; dealId?: string; milestoneId?: string; provider?: string }) {
  authorize(ctx, "payment.record");
  const provider = getPaymentProvider(i.provider ?? "mock");
  if (!provider) throw new ConflictError("Unknown payment provider");
  if (!(i.amount > 0)) throw new ConflictError("Payment amount must be positive");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Contact").findById(i.contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    if (i.invoiceId) {
      const inv: any = await u.repo("Invoice").findById(i.invoiceId, { transaction: u.tx });
      if (!inv) throw new NotFoundError("Invoice");
      if (inv.get("contactId") !== i.contactId) throw new ConflictError("The invoice belongs to a different contact");
    }
    const id = randomUUID();
    const currency = i.currency ?? "AED";
    const checkout = await provider.createCheckout({ amount: i.amount, currency, reference: id });
    await u.repo("Payment").create({
      id, contactId: i.contactId, dealId: i.dealId ?? null, milestoneId: i.milestoneId ?? null, invoiceId: i.invoiceId ?? null, amount: i.amount, currency, method: "card",
      provider: provider.code, providerRef: checkout.providerRef, status: "pending", createdBy: ctx.userId,
    }, { transaction: u.tx });
    return { paymentId: id, checkoutUrl: checkout.checkoutUrl, providerRef: checkout.providerRef };
  });
}

export type PaymentOutcome = "succeeded" | "failed" | "ignored" | "amount_mismatch";

/** Apply a VERIFIED payment callback: idempotent, and an amount that differs from what we asked for is never auto-accepted. */
export async function applyPaymentEvent(sq: Sequelize, tenantId: string, ev: PaymentWebhookEvent, providerCode: string): Promise<PaymentOutcome> {
  const ctx = systemContext(tenantId, `corr_${randomUUID()}`);
  return withUow(sq, ctx, async (u) => {
    const p: any = await u.repo("Payment").findOne({ where: { provider: providerCode, providerRef: ev.providerRef }, transaction: u.tx });
    if (!p) throw new NotFoundError("Payment");
    await u.sq.query("SELECT id FROM payments WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: p.get("id"), t: tenantId }, transaction: u.tx });
    const fresh: any = await u.repo("Payment").findById(p.get("id"), { transaction: u.tx });
    if (fresh.get("status") !== "pending") return "ignored"; // duplicate or late callback
    if (ev.type === "payment.failed") {
      await u.repo("Payment").updateById(fresh.get("id"), { status: "failed", failureReason: ev.failureReason ?? "declined" }, { transaction: u.tx });
      await u.emit({ type: "payment.failed", aggregateType: "payment", aggregateId: fresh.get("id"), payload: { reason: ev.failureReason ?? "declined", contactId: fresh.get("contactId") } });
      return "failed";
    }
    if (toMinor(ev.amount) !== toMinor(fresh.get("amount")) || ev.currency !== fresh.get("currency")) {
      await u.repo("Payment").updateById(fresh.get("id"), { status: "failed", failureReason: `amount mismatch: expected ${fresh.get("amount")} ${fresh.get("currency")}, received ${ev.amount} ${ev.currency}` }, { transaction: u.tx });
      await u.audit({ action: "payment.amount_mismatch", entityType: "payment", entityId: fresh.get("id"), after: { expected: fresh.get("amount"), received: ev.amount } });
      return "amount_mismatch";
    }
    await finalizeSuccess(u, ctx, fresh, new Date(ev.occurredAt));
    return "succeeded";
  });
}

async function getPaymentInUow(u: Uow, id: string) {
  const p = await u.repo("Payment").findById(id, { transaction: u.tx });
  const [receipt, allocs] = await Promise.all([
    u.repo("Receipt").findOne({ where: { paymentId: id }, transaction: u.tx }),
    u.repo("PaymentAllocation").findAll({ where: { paymentId: id }, transaction: u.tx }),
  ]);
  return { ...plain(p), receipt: receipt ? plain(receipt) : null, allocations: allocs.map(plain) };
}

export async function getPayment(sq: Sequelize, ctx: RequestContext, id: string) {
  if (!ctx.grants.some((g) => g.permission === "finance.read" && g.scope === "tenant")) throw new ForbiddenError("Missing permission: finance.read");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Payment").findById(id, { transaction: u.tx }))) throw new NotFoundError("Payment");
    return getPaymentInUow(u, id);
  });
}

export async function listPayments(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string }) {
  if (!ctx.grants.some((g) => g.permission === "finance.read" && g.scope === "tenant")) throw new ForbiddenError("Missing permission: finance.read");
  return withUow(sq, ctx, async (u) => (await u.repo("Payment").findAll({ where: f.status ? { status: f.status } : {}, order: [["createdAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain));
}

/** Payments on a deal are visible to anyone who can read the deal. */
export async function listDealPayments(sq: Sequelize, ctx: RequestContext, dealId: string) {
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "deal.read", DEAL_SCOPE);
    if (!(await u.repo("Deal").findOne({ where: { [Op.and]: [{ id: dealId }, scope] }, transaction: u.tx }))) throw new NotFoundError("Deal");
    return (await u.repo("Payment").findAll({ where: { dealId }, order: [["createdAt", "ASC"]], transaction: u.tx })).map(plain);
  });
}

void hasPermission;
