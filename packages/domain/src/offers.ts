import { randomUUID } from "node:crypto";
import { Op, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { LEAD_SCOPE } from "./leads";
import { setUnitStatusInUow } from "./inventory";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { assertSweepAllowed, ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const OFFER_SCOPE: ScopeColumns = { owner: "agentUserId", branch: "branchId", project: "projectId" };
const ref = (o: any) => ({ ownerUserId: o.get("agentUserId"), branchId: o.get("branchId"), projectId: o.get("projectId") });
const OPEN_OFFER = ["submitted", "countered"];
const HOLD_HOURS = 48;

async function scopedOffer(u: Uow, ctx: RequestContext, id: string) {
  const scope = await scopeWhere(u, ctx, "offer.read", OFFER_SCOPE);
  const o: any = await u.repo("Offer").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!o) throw new NotFoundError("Offer");
  return o;
}

async function addRevision(u: Uow, ctx: RequestContext, offerId: string, amount: number, by: "buyer" | "seller", terms?: unknown) {
  const last: any = await u.repo("OfferRevision").findOne({ where: { offerId }, order: [["revision", "DESC"]], transaction: u.tx });
  const revision = (last?.get("revision") ?? 0) + 1;
  await u.repo("OfferRevision").create({ id: randomUUID(), offerId, revision, amount, terms: terms ?? null, byParty: by, createdBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
  await u.repo("Offer").updateById(offerId, { currentAmount: amount }, { transaction: u.tx });
  return revision;
}

export interface CreateOfferInput { unitId: string; contactId: string; leadId?: string; amount: number; depositAmount?: number; validUntil?: string; terms?: Record<string, unknown> }

export async function createOffer(sq: Sequelize, ctx: RequestContext, i: CreateOfferInput) {
  return withUow(sq, ctx, async (u) => {
    if (!(i.amount > 0)) throw new ConflictError("Offer amount must be positive");
    const unit: any = await u.repo("Unit").findById(i.unitId, { transaction: u.tx });
    if (!unit) throw new NotFoundError("Unit");
    if (unit.get("status") !== "available") throw new ConflictError(`Unit is ${unit.get("status")}: offers are not accepted`);
    if (!(await u.repo("Contact").findById(i.contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    let lead: any = null;
    if (i.leadId) {
      const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
      lead = await u.repo("Lead").findOne({ where: { [Op.and]: [{ id: i.leadId }, scope] }, transaction: u.tx });
      if (!lead) throw new NotFoundError("Lead");
    }
    const agentId = lead?.get("assignedUserId") ?? ctx.userId;
    const branchId = lead?.get("branchId") ?? ctx.membership.branchIds[0] ?? null;
    const projectId = lead?.get("projectId") ?? null;
    authorize(ctx, "offer.manage", { ownerUserId: agentId, branchId, projectId });
    const id = randomUUID();
    await u.repo("Offer").create({
      id, leadId: i.leadId ?? null, contactId: i.contactId, unitId: i.unitId, agentUserId: agentId, branchId, projectId, status: "submitted",
      currentAmount: i.amount, currency: unit.get("currency"), depositAmount: i.depositAmount ?? null, validUntil: i.validUntil ? new Date(i.validUntil) : null, createdBy: ctx.userId,
    }, { transaction: u.tx });
    await addRevision(u, ctx, id, i.amount, "buyer", i.terms);
    await u.emit({ type: "offer.submitted", aggregateType: "offer", aggregateId: id, projectId, payload: { unitId: i.unitId, amount: i.amount } });
    return plain(await u.repo("Offer").findById(id, { transaction: u.tx }));
  });
}

export async function counterOffer(sq: Sequelize, ctx: RequestContext, id: string, i: { amount: number; by: "buyer" | "seller"; terms?: Record<string, unknown> }) {
  return withUow(sq, ctx, async (u) => {
    const o = await scopedOffer(u, ctx, id);
    authorize(ctx, "offer.manage", ref(o));
    if (!OPEN_OFFER.includes(o.get("status"))) throw new ConflictError(`A ${o.get("status")} offer cannot be countered`);
    if (o.get("validUntil") && new Date(o.get("validUntil")) < new Date()) throw new ConflictError("This offer has expired");
    if (!(i.amount > 0)) throw new ConflictError("Offer amount must be positive");
    // Turns alternate: the seller's counter awaits the buyer, and vice versa.
    const status = i.by === "seller" ? "countered" : "submitted";
    if (o.get("status") === status) throw new ConflictError(`It is the ${i.by === "seller" ? "buyer" : "seller"}'s turn to respond`);
    await addRevision(u, ctx, id, i.amount, i.by, i.terms);
    await u.repo("Offer").updateById(id, { status }, { transaction: u.tx });
    await u.emit({ type: "offer.countered", aggregateType: "offer", aggregateId: id, projectId: o.get("projectId"), payload: { by: i.by, amount: i.amount } });
    return plain(await u.repo("Offer").findById(id, { transaction: u.tx }));
  });
}

/** Acceptance is a manager approval (offer.approve). Other open offers on the unit are closed in the same transaction. */
export async function acceptOffer(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const o = await scopedOffer(u, ctx, id);
    authorize(ctx, "offer.approve", ref(o));
    if (!OPEN_OFFER.includes(o.get("status"))) throw new ConflictError(`A ${o.get("status")} offer cannot be accepted`);
    if (o.get("validUntil") && new Date(o.get("validUntil")) < new Date()) throw new ConflictError("This offer has expired");
    await u.repo("Offer").updateById(id, { status: "accepted" }, { transaction: u.tx });
    const others = await u.repo("Offer").findAll({ where: { unitId: o.get("unitId"), status: { [Op.in]: OPEN_OFFER }, id: { [Op.ne]: id } }, transaction: u.tx });
    for (const other of others as any[]) {
      await u.repo("Offer").updateById(other.get("id"), { status: "rejected" }, { transaction: u.tx });
      await u.emit({ type: "offer.rejected", aggregateType: "offer", aggregateId: other.get("id"), projectId: other.get("projectId"), payload: { reason: "another offer was accepted" } });
    }
    await u.audit({ action: "offer.accepted", entityType: "offer", entityId: id, after: { amount: o.get("currentAmount"), unitId: o.get("unitId") } });
    await u.emit({ type: "offer.accepted", aggregateType: "offer", aggregateId: id, projectId: o.get("projectId"), payload: { unitId: o.get("unitId"), amount: o.get("currentAmount") } });
    return plain(await u.repo("Offer").findById(id, { transaction: u.tx }));
  });
}

async function close(sq: Sequelize, ctx: RequestContext, id: string, to: "rejected" | "withdrawn") {
  return withUow(sq, ctx, async (u) => {
    const o = await scopedOffer(u, ctx, id);
    authorize(ctx, "offer.manage", ref(o));
    if (!OPEN_OFFER.includes(o.get("status"))) throw new ConflictError(`A ${o.get("status")} offer cannot be ${to}`);
    await u.repo("Offer").updateById(id, { status: to }, { transaction: u.tx });
    await u.emit({ type: `offer.${to}`, aggregateType: "offer", aggregateId: id, projectId: o.get("projectId"), payload: {} });
    return plain(await u.repo("Offer").findById(id, { transaction: u.tx }));
  });
}
export const rejectOffer = (sq: Sequelize, ctx: RequestContext, id: string) => close(sq, ctx, id, "rejected");
export const withdrawOffer = (sq: Sequelize, ctx: RequestContext, id: string) => close(sq, ctx, id, "withdrawn");

export async function getOffer(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const o = await scopedOffer(u, ctx, id);
    const revisions = await u.repo("OfferRevision").findAll({ where: { offerId: id }, order: [["revision", "ASC"]], transaction: u.tx });
    return { ...plain(o), revisions: revisions.map(plain) };
  });
}

export async function listOffers(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string; unitId?: string }) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "offer.read", OFFER_SCOPE)];
    if (f.status) and.push({ status: f.status });
    if (f.unitId) and.push({ unitId: f.unitId });
    return (await u.repo("Offer").findAll({ where: { [Op.and]: and }, order: [["createdAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}

/** Deadlines live in the database: a scheduler calls this to expire lapsed offers. */
export async function expireOffers(sq: Sequelize, ctx: RequestContext) {
  assertSweepAllowed(ctx, "offer.approve");
  return withUow(sq, ctx, async (u) => {
    const lapsed = await u.repo("Offer").findAll({ where: { status: { [Op.in]: OPEN_OFFER }, validUntil: { [Op.lt]: new Date() } }, transaction: u.tx });
    for (const o of lapsed as any[]) {
      await u.repo("Offer").updateById(o.get("id"), { status: "expired" }, { transaction: u.tx });
      await u.emit({ type: "offer.expired", aggregateType: "offer", aggregateId: o.get("id"), projectId: o.get("projectId"), payload: {} });
    }
    return (lapsed as any[]).map((o) => o.get("id") as string);
  });
}

// ---------------------------------------------------------------- reservations
export async function createReservation(sq: Sequelize, ctx: RequestContext, i: { unitId: string; contactId: string; offerId?: string; depositAmount?: number; holdHours?: number }) {
  authorize(ctx, "reservation.manage");
  return withUow(sq, ctx, async (u) => {
    const unit: any = await u.repo("Unit").findById(i.unitId, { transaction: u.tx });
    if (!unit) throw new NotFoundError("Unit");
    if (!(await u.repo("Contact").findById(i.contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    if (i.offerId) {
      const o: any = await u.repo("Offer").findById(i.offerId, { transaction: u.tx });
      if (!o || o.get("unitId") !== i.unitId) throw new NotFoundError("Offer");
      if (o.get("status") !== "accepted") throw new ConflictError("Only an accepted offer can be reserved");
    }
    const hours = i.holdHours ?? HOLD_HOURS;
    const id = randomUUID();
    try {
      await u.repo("Reservation").create({
        id, unitId: i.unitId, contactId: i.contactId, offerId: i.offerId ?? null, status: "active", expiresAt: new Date(Date.now() + hours * 3_600_000),
        depositAmount: i.depositAmount ?? null, currency: unit.get("currency"), createdBy: ctx.userId,
      }, { transaction: u.tx });
    } catch (e: any) {
      if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") throw new ConflictError("This unit already has an active reservation");
      throw e;
    }
    await setUnitStatusInUow(u, ctx, i.unitId, "reserved", "reservation created");
    await u.audit({ action: "reservation.created", entityType: "reservation", entityId: id, after: { unitId: i.unitId, contactId: i.contactId, holdHours: hours } });
    await u.emit({ type: "reservation.created", aggregateType: "reservation", aggregateId: id, payload: { unitId: i.unitId } });
    return plain(await u.repo("Reservation").findById(id, { transaction: u.tx }));
  });
}

async function releaseReservation(u: Uow, ctx: RequestContext, r: any, to: "cancelled" | "expired", reason: string) {
  await u.repo("Reservation").updateById(r.get("id"), { status: to }, { transaction: u.tx });
  const unit: any = await u.repo("Unit").findById(r.get("unitId"), { transaction: u.tx });
  if (unit?.get("status") === "reserved") await setUnitStatusInUow(u, ctx, r.get("unitId"), "available", reason);
  await u.audit({ action: `reservation.${to}`, entityType: "reservation", entityId: r.get("id"), reason });
  await u.emit({ type: `reservation.${to}`, aggregateType: "reservation", aggregateId: r.get("id"), payload: { unitId: r.get("unitId") } });
}
export { releaseReservation };

export async function cancelReservation(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  authorize(ctx, "reservation.manage");
  if (!reason?.trim()) throw new ConflictError("A cancellation reason is required");
  return withUow(sq, ctx, async (u) => {
    const r: any = await u.repo("Reservation").findById(id, { transaction: u.tx });
    if (!r) throw new NotFoundError("Reservation");
    if (r.get("status") !== "active") throw new ConflictError(`A ${r.get("status")} reservation cannot be cancelled`);
    await releaseReservation(u, ctx, r, "cancelled", reason.trim());
    return plain(await u.repo("Reservation").findById(id, { transaction: u.tx }));
  });
}

/** Scheduler entry point: release units held by reservations whose hold has lapsed. */
export async function expireReservations(sq: Sequelize, ctx: RequestContext) {
  assertSweepAllowed(ctx, "reservation.manage");
  return withUow(sq, ctx, async (u) => {
    const lapsed = await u.repo("Reservation").findAll({ where: { status: "active", expiresAt: { [Op.lt]: new Date() } }, transaction: u.tx });
    for (const r of lapsed as any[]) await releaseReservation(u, ctx, r, "expired", "hold period elapsed");
    return (lapsed as any[]).map((r) => r.get("id") as string);
  });
}

export async function listReservations(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string }) {
  authorize(ctx, "reservation.manage");
  return withUow(sq, ctx, async (u) =>
    (await u.repo("Reservation").findAll({ where: f.status ? { status: f.status } : {}, order: [["createdAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain),
  );
}
