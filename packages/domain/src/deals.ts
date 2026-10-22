import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { calculateCommissionInUow } from "./commissions";
import { setUnitStatusInUow } from "./inventory";
import { closeLeadAsWon } from "./leads";
import { fromMinor, toMinor } from "./money";
import { releaseReservation } from "./offers";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const DEAL_SCOPE: ScopeColumns = { owner: "agentUserId", branch: "branchId", project: "projectId" };
const ref = (d: any) => ({ ownerUserId: d.get("agentUserId"), branchId: d.get("branchId"), projectId: d.get("projectId") });

export const STAGE_ORDER = ["reserved", "contract", "signed", "payment", "registration", "closed"] as const;
export type DealStage = (typeof STAGE_ORDER)[number] | "cancelled";

const MILESTONE_TEMPLATES = {
  sale: [
    { key: "deposit", title: "Reservation deposit received" },
    { key: "contract_signed", title: "Sale contract signed by all parties" },
    { key: "noc", title: "NOC obtained" },
    { key: "registration_completed", title: "Ownership transfer registered" },
  ],
  lease: [
    { key: "deposit", title: "Holding deposit received" },
    { key: "contract_signed", title: "Tenancy contract signed" },
    { key: "registration_completed", title: "Tenancy registered" },
  ],
} as const;

const done = (m: any) => m.get("status") === "done" || m.get("status") === "waived";

/** Extra gates other modules can add (e.g. KYC/AML clearance in the compliance phase). Return blocking reasons. */
export type DealGate = (u: Uow, deal: any, to: DealStage) => Promise<string[]>;
const extraGates: DealGate[] = [];
export const registerDealGate = (g: DealGate) => void extraGates.push(g);

/** Modules (e.g. checklists) that need to react when a deal is created, inside the same transaction. */
export type DealCreatedHook = (u: Uow, deal: any) => Promise<void>;
const createdHooks: DealCreatedHook[] = [];
export const registerDealCreatedHook = (h: DealCreatedHook) => void createdHooks.push(h);

async function stageBlockers(u: Uow, deal: any, to: DealStage): Promise<string[]> {
  const ms = (await u.repo("DealMilestone").findAll({ where: { dealId: deal.get("id") }, transaction: u.tx })) as any[];
  const byKey = new Map(ms.map((m) => [m.get("key"), m]));
  const reasons: string[] = [];
  const need = (key: string, label: string) => { const m = byKey.get(key); if (m && !done(m)) reasons.push(label); };
  if (to === "contract") need("deposit", "Deposit has not been received");
  if (to === "signed") need("contract_signed", "The contract has not been signed");
  if (to === "registration") {
    const open = ms.filter((m) => String(m.get("key")).startsWith("installment_") && !done(m));
    if (open.length) reasons.push(`${open.length} payment-plan instalment(s) are not settled`);
  }
  if (to === "closed") {
    need("registration_completed", "Registration has not been completed");
    for (const m of ms) if (String(m.get("key")).startsWith("installment_") && !done(m)) { reasons.push("Payment-plan instalments are not all settled"); break; }
  }
  for (const g of extraGates) reasons.push(...(await g(u, deal, to)));
  return reasons;
}

async function scopedDeal(u: Uow, ctx: RequestContext, id: string) {
  const scope = await scopeWhere(u, ctx, "deal.read", DEAL_SCOPE);
  const d: any = await u.repo("Deal").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!d) throw new NotFoundError("Deal");
  return d;
}

async function stageEvent(u: Uow, ctx: RequestContext, dealId: string, from: string | null, to: string, reason?: string | null) {
  await u.repo("DealStageEvent").create({ id: randomUUID(), dealId, fromStage: from, toStage: to, actorId: ctx.userId, reason: reason ?? null, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
}

export interface CreateDealInput { reservationId: string; dealType?: "sale" | "lease"; amount?: number }

export async function createDeal(sq: Sequelize, ctx: RequestContext, i: CreateDealInput) {
  authorize(ctx, "deal.create");
  return withUow(sq, ctx, async (u) => {
    const res: any = await u.repo("Reservation").findById(i.reservationId, { transaction: u.tx });
    if (!res) throw new NotFoundError("Reservation");
    if (res.get("status") !== "active") throw new ConflictError(`A ${res.get("status")} reservation cannot start a deal`);
    if (new Date(res.get("expiresAt")) < new Date()) throw new ConflictError("This reservation has expired");
    const unit: any = await u.repo("Unit").findById(res.get("unitId"), { transaction: u.tx });
    const offer: any = res.get("offerId") ? await u.repo("Offer").findById(res.get("offerId"), { transaction: u.tx }) : null;
    const amount = offer ? Number(offer.get("currentAmount")) : i.amount;
    if (!(amount && amount > 0)) throw new ConflictError("A deal amount is required (no accepted offer is attached)");
    if (offer && i.amount !== undefined && Math.abs(i.amount - amount) > 0.005) throw new ConflictError("The deal amount must equal the accepted offer amount");
    const type = i.dealType ?? "sale";
    const agentId = offer?.get("agentUserId") ?? ctx.userId;
    const branchId = offer?.get("branchId") ?? ctx.membership.branchIds[0] ?? null;
    const projectId = offer?.get("projectId") ?? null;
    const id = randomUUID();
    try {
      await u.repo("Deal").create({
        id, dealType: type, leadId: offer?.get("leadId") ?? null, unitId: res.get("unitId"), contactId: res.get("contactId"), offerId: offer?.get("id") ?? null, reservationId: res.get("id"),
        agentUserId: agentId, branchId, projectId, stage: "reserved", status: "open", amount, currency: unit.get("currency"), createdBy: ctx.userId,
      }, { transaction: u.tx });
    } catch (e: any) {
      if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") throw new ConflictError("This unit already has an open deal");
      throw e;
    }
    await u.repo("DealParty").create({ id: randomUUID(), dealId: id, contactId: res.get("contactId"), role: type === "sale" ? "buyer" : "tenant", sharePct: 100 }, { transaction: u.tx });
    if (unit.get("ownerContactId")) await u.repo("DealParty").create({ id: randomUUID(), dealId: id, contactId: unit.get("ownerContactId"), role: type === "sale" ? "seller" : "landlord", sharePct: 100 }, { transaction: u.tx });
    let order = 0;
    for (const m of MILESTONE_TEMPLATES[type]) {
      await u.repo("DealMilestone").create({
        id: randomUUID(), dealId: id, key: m.key, title: m.title, sortOrder: order++, amount: m.key === "deposit" && res.get("depositAmount") != null ? res.get("depositAmount") : null, status: "pending",
      }, { transaction: u.tx });
    }
    await u.repo("Reservation").updateById(res.get("id"), { status: "converted", dealId: id }, { transaction: u.tx });
    { const created = await u.repo("Deal").findById(id, { transaction: u.tx }); for (const h of createdHooks) await h(u, created); }
    await stageEvent(u, ctx, id, null, "reserved", "deal created");
    await u.audit({ action: "deal.created", entityType: "deal", entityId: id, after: { unitId: res.get("unitId"), amount, type } });
    await u.emit({ type: "deal.reserved", aggregateType: "deal", aggregateId: id, projectId, payload: { unitId: res.get("unitId"), amount, dealType: type } });
    return plain(await u.repo("Deal").findById(id, { transaction: u.tx }));
  });
}

/** Forward one stage at a time; every gate must be clear. Closing is a manager approval (deal.close). */
export async function advanceDealStage(sq: Sequelize, ctx: RequestContext, id: string, i: { to: (typeof STAGE_ORDER)[number]; reason?: string }) {
  return withUow(sq, ctx, async (u) => {
    const d = await scopedDeal(u, ctx, id);
    if (d.get("status") !== "open") throw new ConflictError(`A ${d.get("status")} deal cannot change stage`);
    const from = d.get("stage") as (typeof STAGE_ORDER)[number];
    const fi = STAGE_ORDER.indexOf(from);
    const ti = STAGE_ORDER.indexOf(i.to);
    if (ti === fi) return plain(d);
    if (ti < fi) {
      authorize(ctx, "deal.close", ref(d)); // stepping back is a manager decision and needs a reason
      if (!i.reason?.trim()) throw new ConflictError("A reason is required to move a deal backwards");
    } else if (ti > fi + 1) {
      throw new ConflictError(`Stages cannot be skipped: next is "${STAGE_ORDER[fi + 1]}"`);
    } else {
      authorize(ctx, i.to === "closed" ? "deal.close" : "deal.update", ref(d));
      const blockers = await stageBlockers(u, d, i.to);
      if (blockers.length) throw new DealBlockedError(blockers);
    }
    const patch: Record<string, unknown> = { stage: i.to };
    if (i.to === "closed") {
      patch.status = "closed";
      patch.closedAt = new Date();
      await setUnitStatusInUow(u, ctx, d.get("unitId"), d.get("dealType") === "sale" ? "sold" : "rented", "deal closed");
      if (d.get("leadId")) await closeLeadAsWon(u, ctx, d.get("leadId"));
    }
    await u.repo("Deal").updateById(id, patch, { transaction: u.tx });
    await stageEvent(u, ctx, id, from, i.to, i.reason);
    if (i.to === "closed") {
      const fresh = await u.repo("Deal").findById(id, { transaction: u.tx });
      await calculateCommissionInUow(u, ctx, fresh);
      await u.audit({ action: "deal.closed", entityType: "deal", entityId: id, after: { amount: d.get("amount") } });
      await u.emit({ type: "deal.closed", aggregateType: "deal", aggregateId: id, projectId: d.get("projectId"), payload: { amount: d.get("amount"), dealType: d.get("dealType") } });
    } else {
      await u.emit({ type: "deal.stage_changed", aggregateType: "deal", aggregateId: id, projectId: d.get("projectId"), payload: { from, to: i.to } });
    }
    return plain(await u.repo("Deal").findById(id, { transaction: u.tx }));
  });
}

export class DealBlockedError extends Error {
  status = 422;
  constructor(public reasons: string[]) {
    super("The deal cannot advance yet");
    this.name = "DealBlockedError";
  }
}

export async function cancelDeal(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  if (!reason?.trim()) throw new ConflictError("A cancellation reason is required");
  return withUow(sq, ctx, async (u) => {
    const d = await scopedDeal(u, ctx, id);
    authorize(ctx, "deal.close", ref(d));
    if (d.get("status") !== "open") throw new ConflictError(`A ${d.get("status")} deal cannot be cancelled`);
    // Refunds are not implemented yet: refuse to orphan money rather than silently cancelling.
    const [paid] = await u.sq.query<{ n: number }>("SELECT COUNT(*) n FROM payments WHERE tenant_id=:t AND deal_id=:d AND status='succeeded'", { replacements: { t: ctx.tenantId, d: id }, transaction: u.tx, type: QueryTypes.SELECT });
    if (Number(paid?.n ?? 0) > 0) throw new ConflictError("This deal has received payments; refund handling is required before it can be cancelled");
    const from = d.get("stage");
    await u.repo("Deal").updateById(id, { stage: "cancelled", status: "cancelled", cancelledReason: reason.trim() }, { transaction: u.tx });
    const res: any = d.get("reservationId") ? await u.repo("Reservation").findById(d.get("reservationId"), { transaction: u.tx }) : null;
    if (res && ["active", "converted"].includes(res.get("status"))) {
      await u.repo("Reservation").updateById(res.get("id"), { status: "cancelled" }, { transaction: u.tx });
    }
    const unit: any = await u.repo("Unit").findById(d.get("unitId"), { transaction: u.tx });
    if (unit?.get("status") === "reserved") await setUnitStatusInUow(u, ctx, d.get("unitId"), "available", "deal cancelled");
    await stageEvent(u, ctx, id, from, "cancelled", reason.trim());
    await u.audit({ action: "deal.cancelled", entityType: "deal", entityId: id, before: { stage: from }, reason: reason.trim() });
    await u.emit({ type: "deal.cancelled", aggregateType: "deal", aggregateId: id, projectId: d.get("projectId"), payload: { from } });
    void releaseReservation;
    return plain(await u.repo("Deal").findById(id, { transaction: u.tx }));
  });
}

export async function setPaymentPlan(sq: Sequelize, ctx: RequestContext, id: string, installments: Array<{ title: string; dueDate: string; amount: number }>) {
  return withUow(sq, ctx, async (u) => {
    const d = await scopedDeal(u, ctx, id);
    authorize(ctx, "deal.update", ref(d));
    if (d.get("status") !== "open" || ["registration", "closed"].includes(d.get("stage"))) throw new ConflictError("The payment plan can no longer be changed");
    if (installments.some((x) => !(x.amount > 0))) throw new ConflictError("Every instalment needs a positive amount");
    const existing = (await u.repo("DealMilestone").findAll({ where: { dealId: id, key: { [Op.like]: "installment\\_%" } }, transaction: u.tx })) as any[];
    if (existing.some((m) => m.get("status") === "done")) throw new ConflictError("Instalments that are already settled cannot be replaced");
    const deposit: any = await u.repo("DealMilestone").findOne({ where: { dealId: id, key: "deposit" }, transaction: u.tx });
    const total = installments.reduce((a, x) => a + toMinor(x.amount), 0) + toMinor(deposit?.get("amount"));
    if (total > toMinor(d.get("amount"))) throw new ConflictError(`Deposit and instalments (${fromMinor(total)}) exceed the deal amount (${fromMinor(toMinor(d.get("amount")))})`);
    await u.repo("DealMilestone").deleteWhere({ dealId: id, key: { [Op.like]: "installment\\_%" } }, { transaction: u.tx });
    const base = 100;
    for (const [idx, x] of installments.entries()) {
      await u.repo("DealMilestone").create({ id: randomUUID(), dealId: id, key: `installment_${idx + 1}`, title: x.title, sortOrder: base + idx, dueDate: x.dueDate, amount: x.amount, status: "pending" }, { transaction: u.tx });
    }
    await u.audit({ action: "deal.payment_plan_set", entityType: "deal", entityId: id, after: { installments: installments.length, total: fromMinor(total) } });
    return getDealInUow(u, ctx, id);
  });
}

/** Manual completion/waiver. Evidence-driven milestones (deposit, contract) are manager-only and need a reason. */
export async function completeMilestone(sq: Sequelize, ctx: RequestContext, dealId: string, key: string, i: { waive?: boolean; reason?: string } = {}) {
  return withUow(sq, ctx, async (u) => {
    const d = await scopedDeal(u, ctx, dealId);
    authorize(ctx, "deal.update", ref(d));
    if (d.get("status") !== "open") throw new ConflictError("Milestones on a closed or cancelled deal cannot change");
    const m: any = await u.repo("DealMilestone").findOne({ where: { dealId, key }, transaction: u.tx });
    if (!m) throw new NotFoundError("Milestone");
    if (done(m)) return plain(m);
    const evidenceDriven = ["deposit", "contract_signed"].includes(key) || key.startsWith("installment_");
    if (i.waive || evidenceDriven) {
      authorize(ctx, "deal.close", ref(d));
      if (!i.reason?.trim()) throw new ConflictError("A reason is required for a manual override");
    }
    await u.repo("DealMilestone").updateById(m.get("id"), { status: i.waive ? "waived" : "done", completedAt: new Date(), completedBy: ctx.userId }, { transaction: u.tx });
    if (i.waive || evidenceDriven) await u.audit({ action: i.waive ? "milestone.waived" : "milestone.completed_manually", entityType: "deal_milestone", entityId: m.get("id"), reason: i.reason, after: { dealId, key } });
    await u.emit({ type: "deal.milestone_completed", aggregateType: "deal", aggregateId: dealId, projectId: d.get("projectId"), payload: { key, manual: true } });
    return plain(await u.repo("DealMilestone").findById(m.get("id"), { transaction: u.tx }));
  });
}

/** System-driven completion (signature completed, payment received). No user permission: the caller has verified the evidence. */
export async function completeMilestoneInUow(u: Uow, dealId: string, key: string, actor: string, meta: Record<string, unknown> = {}) {
  const m: any = await u.repo("DealMilestone").findOne({ where: { dealId, key }, transaction: u.tx });
  if (!m || done(m)) return false;
  await u.repo("DealMilestone").updateById(m.get("id"), { status: "done", completedAt: new Date(), completedBy: actor }, { transaction: u.tx });
  const deal: any = await u.repo("Deal").findById(dealId, { transaction: u.tx });
  await u.emit({ type: "deal.milestone_completed", aggregateType: "deal", aggregateId: dealId, projectId: deal?.get("projectId") ?? null, payload: { key, manual: false, ...meta } });
  return true;
}

async function getDealInUow(u: Uow, ctx: RequestContext, id: string) {
  const d = await scopedDeal(u, ctx, id);
  const [parties, milestones, events] = await Promise.all([
    u.repo("DealParty").findAll({ where: { dealId: id }, transaction: u.tx }),
    u.repo("DealMilestone").findAll({ where: { dealId: id }, order: [["sortOrder", "ASC"]], transaction: u.tx }),
    u.repo("DealStageEvent").findAll({ where: { dealId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
  ]);
  return { ...plain(d), parties: parties.map(plain), milestones: milestones.map(plain), stageEvents: events.map(plain) };
}

export async function getDeal(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, (u) => getDealInUow(u, ctx, id));
}

export async function listDeals(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string; stage?: string }) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "deal.read", DEAL_SCOPE)];
    if (f.status) and.push({ status: f.status });
    if (f.stage) and.push({ stage: f.stage });
    return (await u.repo("Deal").findAll({ where: { [Op.and]: and }, order: [["createdAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}

export { scopedDeal, getDealInUow };
