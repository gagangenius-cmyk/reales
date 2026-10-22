import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { requireStepUp } from "@reales/auth";
import { ForbiddenError, hasPermission } from "@reales/rbac";
import { fromMinor, toMinor } from "./money";
import { notifyInUow } from "./notifications";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

const mustHave = (ctx: RequestContext, p: string) => { if (!hasPermission(ctx, p)) throw new ForbiddenError(`Missing permission: ${p}`); };
const canDecide = (ctx: RequestContext) => hasPermission(ctx, "commission.approve");

interface Payable { calculationId: string; dealId: string; commission: number; amount: string; vat: string; currency: string; calculatedAt: string; role: string }

/**
 * Approved commissions where the caller is a payee and nothing is requested yet. An external agent invoices with VAT, so VAT on their share is
 * included in what they are paid; an internal agent's share carries no VAT.
 */
async function payableFor(u: Uow, tenantId: string, userId: string): Promise<Payable[]> {
  const profile: any = await u.repo("AgentProfile").findOne({ where: { userId }, transaction: u.tx });
  const external = profile?.get("agentType") === "external";
  const rows = await u.sq.query<{ calc_id: string; deal_id: string; commission: string; share: string; currency: string; calculated_at: Date; role: string; vat_pct: string | null }>(
    `SELECT c.id AS calc_id, c.deal_id, c.commission_amount AS commission, s.amount AS share, c.currency, c.calculated_at, s.role, p.vat_pct
       FROM commission_calculations c
       JOIN commission_splits s ON s.calculation_id = c.id AND s.tenant_id = c.tenant_id AND s.user_id = :u
       LEFT JOIN commission_plans p ON p.id = c.plan_id AND p.tenant_id = c.tenant_id
      WHERE c.tenant_id = :t AND c.status = 'approved' AND c.paid_at IS NULL AND s.amount > 0
        AND NOT EXISTS (SELECT 1 FROM payout_request_items i WHERE i.tenant_id = c.tenant_id AND i.calculation_id = c.id AND i.active = 1 AND i.id IS NOT NULL AND EXISTS (SELECT 1 FROM payout_requests r WHERE r.id = i.request_id AND r.tenant_id = i.tenant_id AND r.status <> 'rejected' AND r.status <> 'cancelled'))
      ORDER BY c.calculated_at ASC`,
    { replacements: { t: tenantId, u: userId }, transaction: u.tx, type: QueryTypes.SELECT },
  );
  return rows.map((r) => {
    const amount = toMinor(r.share);
    const vat = external ? Math.round((amount * Number(r.vat_pct ?? 5)) / 100) : 0;
    return { calculationId: r.calc_id, dealId: r.deal_id, commission: Number(r.commission), amount: fromMinor(amount), vat: fromMinor(vat), currency: r.currency, calculatedAt: new Date(r.calculated_at).toISOString(), role: r.role };
  });
}

export async function listPayable(sq: Sequelize, ctx: RequestContext) {
  mustHave(ctx, "payout.request");
  return withUow(sq, ctx, (u) => payableFor(u, ctx.tenantId, ctx.userId));
}

/** Ask finance to pay your share of the chosen approved commissions. One currency per request. */
export async function requestPayout(sq: Sequelize, ctx: RequestContext, i: { calculationIds: string[]; invoiceRef?: string; note?: string }) {
  mustHave(ctx, "payout.request");
  const ids = [...new Set(i.calculationIds)];
  if (!ids.length) throw new ConflictError("Choose at least one commission");
  return withUow(sq, ctx, async (u) => {
    await u.sq.query("SELECT id FROM users WHERE id=:u AND tenant_id=:t FOR UPDATE", { replacements: { u: ctx.userId, t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT }); // serialises a person's own requests
    const payable = await payableFor(u, ctx.tenantId, ctx.userId);
    const chosen = ids.map((id) => payable.find((p) => p.calculationId === id));
    if (chosen.some((c) => !c)) throw new ConflictError("One of those commissions is not available to request (not approved, already paid or already requested)");
    const rows = chosen as Payable[];
    if (new Set(rows.map((r) => r.currency)).size > 1) throw new ConflictError("Request one currency at a time");
    const profile: any = await u.repo("AgentProfile").findOne({ where: { userId: ctx.userId }, transaction: u.tx });
    if (profile?.get("agentType") === "external" && !i.invoiceRef?.trim()) throw new ConflictError("External agents must give their tax invoice number");
    const net = rows.reduce((a, r) => a + toMinor(r.amount), 0), vat = rows.reduce((a, r) => a + toMinor(r.vat), 0);
    const id = randomUUID();
    await u.repo("PayoutRequest").create({ id, userId: ctx.userId, status: "pending", netAmount: fromMinor(net), vatAmount: fromMinor(vat), totalAmount: fromMinor(net + vat), currency: rows[0]!.currency, invoiceRef: i.invoiceRef?.trim() || null, note: i.note?.trim() || null, requestedAt: mysqlDate(new Date()) }, { transaction: u.tx });
    for (const r of rows) await u.repo("PayoutRequestItem").create({ id: randomUUID(), requestId: id, calculationId: r.calculationId, amount: r.amount, vatAmount: r.vat, active: true }, { transaction: u.tx });
    const finance = await u.sq.query<{ user_id: string }>("SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id AND rp.tenant_id=ur.tenant_id JOIN permissions p ON p.id=rp.permission_id WHERE ur.tenant_id=:t AND p.`key`='commission.approve'", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    for (const f of finance) await notifyInUow(u, { userId: f.user_id, kind: "payout.requested", title: "A payout was requested", body: `${rows[0]!.currency} ${Number(fromMinor(net + vat)).toLocaleString("en-US")} for ${rows.length} commission(s).`, entityType: "payout_request", entityId: id, dedupeKey: `payout:${id}:${f.user_id}` });
    await u.audit({ action: "payout.requested", entityType: "payout_request", entityId: id, after: { total: fromMinor(net + vat), items: rows.length } });
    return plain(await u.repo("PayoutRequest").findById(id, { transaction: u.tx }));
  });
}

async function load(u: Uow, id: string) {
  const r: any = await u.repo("PayoutRequest").findById(id, { transaction: u.tx });
  if (!r) throw new NotFoundError("Payout request");
  return r;
}

export async function cancelPayout(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const r = await load(u, id);
    if (r.get("userId") !== ctx.userId) throw new ForbiddenError("Only the requester can cancel");
    if (r.get("status") !== "pending") throw new ConflictError(`A ${r.get("status")} request cannot be cancelled`);
    await u.repo("PayoutRequest").updateById(id, { status: "cancelled" }, { transaction: u.tx });
    await u.repo("PayoutRequestItem").updateWhere({ requestId: id }, { active: false }, { transaction: u.tx });
    await u.audit({ action: "payout.cancelled", entityType: "payout_request", entityId: id });
    return plain(await load(u, id));
  });
}

/** Finance decision. Approval needs a fresh second factor; a rejection needs a reason and releases the commissions to be requested again. */
export async function decidePayout(sq: Sequelize, ctx: RequestContext, id: string, i: { outcome: "approved" | "rejected"; reason?: string }) {
  mustHave(ctx, "commission.approve");
  if (i.outcome === "approved") requireStepUp(ctx);
  if (i.outcome === "rejected" && !i.reason?.trim()) throw new ConflictError("A reason is required to reject a payout request");
  return withUow(sq, ctx, async (u) => {
    await u.sq.query("SELECT id FROM payout_requests WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id, t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    const r = await load(u, id);
    if (r.get("status") !== "pending") throw new ConflictError(`A ${r.get("status")} request cannot be decided again`);
    if (r.get("userId") === ctx.userId) throw new ForbiddenError("You cannot decide your own payout request");
    await u.repo("PayoutRequest").updateById(id, { status: i.outcome, decidedBy: ctx.userId, decidedAt: new Date(), decisionReason: i.reason?.trim() || null }, { transaction: u.tx });
    if (i.outcome === "rejected") await u.repo("PayoutRequestItem").updateWhere({ requestId: id }, { active: false }, { transaction: u.tx });
    await notifyInUow(u, { userId: r.get("userId"), kind: `payout.${i.outcome}`, title: `Your payout request was ${i.outcome}`, body: i.reason?.trim() ?? undefined, entityType: "payout_request", entityId: id, dedupeKey: `payout-decision:${id}` });
    await u.audit({ action: `payout.${i.outcome}`, entityType: "payout_request", entityId: id, reason: i.reason, after: { total: r.get("totalAmount") } });
    return plain(await load(u, id));
  });
}

export async function markPayoutPaid(sq: Sequelize, ctx: RequestContext, id: string, reference: string) {
  mustHave(ctx, "commission.approve");
  requireStepUp(ctx);
  if (!reference.trim()) throw new ConflictError("A payment reference is required");
  return withUow(sq, ctx, async (u) => {
    await u.sq.query("SELECT id FROM payout_requests WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id, t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    const r = await load(u, id);
    if (r.get("status") !== "approved") throw new ConflictError("Only an approved request can be paid");
    await u.repo("PayoutRequest").updateById(id, { status: "paid", paidBy: ctx.userId, paidAt: new Date(), paidReference: reference.trim() }, { transaction: u.tx });
    await notifyInUow(u, { userId: r.get("userId"), kind: "payout.paid", title: "Your payout was paid", body: `Reference ${reference.trim()}`, entityType: "payout_request", entityId: id, dedupeKey: `payout-paid:${id}` });
    await u.audit({ action: "payout.paid", entityType: "payout_request", entityId: id, after: { reference: reference.trim(), total: r.get("totalAmount") } });
    return plain(await load(u, id));
  });
}

/** Finance sees every request; everyone else only their own. */
export async function listPayouts(sq: Sequelize, ctx: RequestContext, f: { status?: string; limit?: number } = {}) {
  if (!canDecide(ctx) && !hasPermission(ctx, "payout.request")) throw new ForbiddenError("Missing permission: payout.request");
  return withUow(sq, ctx, async (u) => {
    const where: Record<string, unknown> = { ...(canDecide(ctx) ? {} : { userId: ctx.userId }), ...(f.status ? { status: f.status } : {}) };
    const rows = (await u.repo("PayoutRequest").findAll({ where, order: [["requestedAt", "DESC"]], limit: Math.min(f.limit ?? 100, 300), transaction: u.tx })) as any[];
    const [users, items] = await Promise.all([
      u.repo("User").findAll({ where: { id: { [Op.in]: [...new Set(rows.map((r) => r.get("userId")))].concat(["-"]) } }, transaction: u.tx }),
      u.repo("PayoutRequestItem").findAll({ where: { requestId: { [Op.in]: rows.map((r) => r.get("id")).concat(["-"]) } }, transaction: u.tx }),
    ]);
    const email = new Map((users as any[]).map((x) => [x.get("id"), x.get("email") as string]));
    return rows.map((r) => ({ ...plain(r), agent: email.get(r.get("userId")) ?? "Agent", items: (items as any[]).filter((i) => i.get("requestId") === r.get("id")).map(plain) }));
  });
}
