import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, RequestContext, systemContext } from "@reales/database";
import { requireStepUp } from "@reales/auth";
import { authorize, can } from "@reales/rbac";
import { createSucceededPaymentInUow } from "./finance";
import { allocateEqual, fromMinor, toMinor } from "./money";
import { resolveLeaseRule } from "./regulatory";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { assertSweepAllowed, ConflictError, NotFoundError, Uow, withUow } from "./uow";

// ---------------------------------------------------------------- date helpers (calendar dates as YYYY-MM-DD, UTC)
export const today = () => new Date().toISOString().slice(0, 10);
const parse = (d: string) => { const [y, m, day] = d.split("-").map(Number); return { y: y!, m: m!, d: day! }; };
const fmt = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addMonths(date: string, n: number): string {
  const { y, m, d } = parse(date);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysIn(ny, nm)));
}
export function addDays(date: string, n: number): string {
  const { y, m, d } = parse(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** Whole months in an inclusive term [starts, ends]; null when the term is not a whole number of months. */
export function termMonths(starts: string, ends: string): number | null {
  for (let m = 1; m <= 120; m++) if (addDays(addMonths(starts, m), -1) === ends) return m;
  return null;
}

/** The contract's total rent for the term. The schedule is generated to sum to EXACTLY this amount. */
export const contractTotalMinor = (annualRent: number | string, months: number) => Math.round((toMinor(annualRent) * months) / 12);

export interface ScheduleRow { seq: number; dueDate: string; amountMinor: number }
export function buildRentSchedule(starts: string, months: number, annualRent: number | string, installments: number): ScheduleRow[] {
  const parts = allocateEqual(contractTotalMinor(annualRent, months), installments);
  return parts.map((amountMinor, i) => ({ seq: i + 1, dueDate: addMonths(starts, Math.floor((i * months) / installments)), amountMinor }));
}

export const LEASE_SCOPE: ScopeColumns = { owner: "agentUserId", branch: "branchId", portfolio: "portfolioId" };
const ref = (l: any) => ({ ownerUserId: l.get("agentUserId"), branchId: l.get("branchId"), portfolioId: l.get("portfolioId") });
const ALLOWED_INSTALLMENTS = [1, 2, 3, 4, 6, 12];

// ---------------------------------------------------------------- portfolios and ownership
export const PORTFOLIO_SCOPE: ScopeColumns = { branch: "branchId", portfolio: "id" };

export async function createPortfolio(sq: Sequelize, ctx: RequestContext, i: { name: string; ownerContactId: string; branchId?: string }) {
  authorize(ctx, "portfolio.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Contact").findById(i.ownerContactId, { transaction: u.tx }))) throw new NotFoundError("Owner contact");
    if (i.branchId && !(await u.repo("Branch").findById(i.branchId, { transaction: u.tx }))) throw new NotFoundError("Branch");
    const p = await u.repo("Portfolio").create({ id: randomUUID(), name: i.name, ownerContactId: i.ownerContactId, branchId: i.branchId ?? null, status: "active" }, { transaction: u.tx });
    await u.audit({ action: "portfolio.created", entityType: "portfolio", entityId: (p as any).get("id"), after: i });
    return plain(p);
  });
}

export async function listPortfolios(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "portfolio.read", PORTFOLIO_SCOPE);
    return (await u.repo("Portfolio").findAll({ where: scope, order: [["name", "ASC"]], transaction: u.tx })).map(plain);
  });
}

/** Active co-ownership shares for a unit can never exceed 100%. The unit row is locked so concurrent assignments cannot both fit. */
export async function assignOwnership(sq: Sequelize, ctx: RequestContext, i: { unitId: string; portfolioId: string; sharePct?: number; fromDate: string }) {
  authorize(ctx, "portfolio.manage");
  const share = i.sharePct ?? 100;
  if (!(share > 0 && share <= 100)) throw new ConflictError("Share must be between 0 and 100 percent");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Portfolio").findById(i.portfolioId, { transaction: u.tx }))) throw new NotFoundError("Portfolio");
    if (!(await u.repo("Unit").findById(i.unitId, { transaction: u.tx }))) throw new NotFoundError("Unit");
    await u.sq.query("SELECT id FROM units WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: i.unitId, t: ctx.tenantId }, transaction: u.tx });
    const active = (await u.repo("Ownership").findAll({ where: { unitId: i.unitId, toDate: null }, transaction: u.tx })) as any[];
    if (active.some((o) => o.get("portfolioId") === i.portfolioId)) throw new ConflictError("This portfolio already owns the unit");
    const total = active.reduce((a, o) => a + Number(o.get("sharePct")), 0) + share;
    if (total > 100.0001) throw new ConflictError(`Ownership would total ${total}% (maximum 100%)`);
    const o = await u.repo("Ownership").create({ id: randomUUID(), unitId: i.unitId, portfolioId: i.portfolioId, sharePct: share, fromDate: i.fromDate, toDate: null }, { transaction: u.tx });
    await u.audit({ action: "ownership.assigned", entityType: "unit", entityId: i.unitId, after: { portfolioId: i.portfolioId, sharePct: share } });
    return plain(o);
  });
}

export async function createManagementAgreement(sq: Sequelize, ctx: RequestContext, i: { portfolioId: string; feePct: number; startsOn: string; endsOn?: string; documentId?: string }) {
  authorize(ctx, "portfolio.manage");
  if (!(i.feePct >= 0 && i.feePct <= 100)) throw new ConflictError("Fee must be between 0 and 100 percent");
  if (i.endsOn && i.endsOn < i.startsOn) throw new ConflictError("The agreement cannot end before it starts");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Portfolio").findById(i.portfolioId, { transaction: u.tx }))) throw new NotFoundError("Portfolio");
    const live = await u.repo("ManagementAgreement").findOne({ where: { portfolioId: i.portfolioId, status: "active" }, transaction: u.tx });
    if (live) throw new ConflictError("This portfolio already has an active management agreement");
    return plain(await u.repo("ManagementAgreement").create({ id: randomUUID(), portfolioId: i.portfolioId, feePct: i.feePct, startsOn: i.startsOn, endsOn: i.endsOn ?? null, status: "active", documentId: i.documentId ?? null }, { transaction: u.tx }));
  });
}

// ---------------------------------------------------------------- leases
export interface CreateLeaseInput {
  unitId: string; startsOn: string; endsOn: string; annualRent: number; installments?: number; tenantContactIds: string[]; guarantorContactIds?: string[];
  landlordContactId?: string; depositAmount?: number; agentUserId?: string; portfolioId?: string; registrationRef?: string; previousLeaseId?: string;
}

async function effectiveEnd(l: any): Promise<string> {
  return (l.get("terminatedOn") as string | null) ?? (l.get("endsOn") as string);
}

/** Contradictory occupancy guard: any other lease of the unit whose (effective) period overlaps the requested one. Call with the unit row locked. */
async function assertNoOverlap(u: Uow, unitId: string, starts: string, ends: string, exceptLeaseId?: string) {
  const others = (await u.repo("Lease").findAll({ where: { unitId, ...(exceptLeaseId ? { id: { [Op.ne]: exceptLeaseId } } : {}) }, transaction: u.tx })) as any[];
  for (const o of others) {
    const oEnd = await effectiveEnd(o);
    if (o.get("startsOn") <= ends && starts <= oEnd) throw new ConflictError(`The unit already has a lease from ${o.get("startsOn")} to ${oEnd}`);
  }
}

export async function createLease(sq: Sequelize, ctx: RequestContext, i: CreateLeaseInput) {
  return withUow(sq, ctx, async (u) => {
    const unit: any = await u.repo("Unit").findById(i.unitId, { transaction: u.tx });
    if (!unit) throw new NotFoundError("Unit");
    const building: any = await u.repo("Building").findById(unit.get("buildingId"), { transaction: u.tx });
    const project: any = await u.repo("ReProject").findById(building.get("reProjectId"), { transaction: u.tx });
    const jurisdiction = project.get("jurisdictionCode") as string;
    const rule = await resolveLeaseRule(sq, jurisdiction);
    if (!rule) throw new ConflictError(`No lease rules are configured for ${jurisdiction}`);

    const months = termMonths(i.startsOn, i.endsOn);
    if (!months) throw new ConflictError("The lease term must be a whole number of months (start 2026-01-01, end 2026-12-31 is 12 months)");
    if (!(i.annualRent > 0)) throw new ConflictError("Annual rent must be positive");
    const installments = i.installments ?? 1;
    if (!ALLOWED_INSTALLMENTS.includes(installments) || installments > rule.definition.maxInstallments || installments > months) throw new ConflictError("Unsupported number of instalments for this term");
    if (!i.tenantContactIds.length) throw new ConflictError("A lease needs at least one tenant");

    // Ownership gives the managing portfolio; an explicit portfolio must actually own the unit.
    const owners = (await u.repo("Ownership").findAll({ where: { unitId: i.unitId, toDate: null }, transaction: u.tx })) as any[];
    let portfolioId = i.portfolioId ?? (owners.length === 1 ? owners[0].get("portfolioId") : null);
    if (i.portfolioId && !owners.some((o) => o.get("portfolioId") === i.portfolioId)) throw new ConflictError("That portfolio does not own this unit");
    const portfolio: any = portfolioId ? await u.repo("Portfolio").findById(portfolioId, { transaction: u.tx }) : null;
    const agentId = i.agentUserId ?? (ctx.userId === "system" ? null : ctx.userId);
    const branchId = portfolio?.get("branchId") ?? ctx.membership.branchIds[0] ?? null;
    authorize(ctx, "lease.manage", { ownerUserId: agentId, branchId, portfolioId });

    for (const cid of [...i.tenantContactIds, ...(i.guarantorContactIds ?? []), ...(i.landlordContactId ? [i.landlordContactId] : [])]) {
      if (!(await u.repo("Contact").findById(cid, { transaction: u.tx }))) throw new NotFoundError("Contact");
    }
    if (agentId && !(await u.repo("User").findOne({ where: { id: agentId, status: "active" }, transaction: u.tx }))) throw new NotFoundError("Agent");

    await u.sq.query("SELECT id FROM units WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: i.unitId, t: ctx.tenantId }, transaction: u.tx });
    await assertNoOverlap(u, i.unitId, i.startsOn, i.endsOn);

    const id = randomUUID();
    await u.repo("Lease").create({
      id, unitId: i.unitId, portfolioId, branchId, agentUserId: agentId, previousLeaseId: i.previousLeaseId ?? null, status: "draft", startsOn: i.startsOn, endsOn: i.endsOn,
      annualRent: i.annualRent, currency: unit.get("currency"), installments, registrationRef: i.registrationRef ?? null, jurisdictionCode: jurisdiction, createdBy: ctx.userId,
    }, { transaction: u.tx });
    for (const cid of i.tenantContactIds) await u.repo("LeaseParty").create({ id: randomUUID(), leaseId: id, contactId: cid, role: "tenant" }, { transaction: u.tx });
    for (const cid of i.guarantorContactIds ?? []) await u.repo("LeaseParty").create({ id: randomUUID(), leaseId: id, contactId: cid, role: "guarantor" }, { transaction: u.tx });
    const landlord = i.landlordContactId ?? portfolio?.get("ownerContactId");
    if (landlord) await u.repo("LeaseParty").create({ id: randomUUID(), leaseId: id, contactId: landlord, role: "landlord" }, { transaction: u.tx });
    for (const row of buildRentSchedule(i.startsOn, months, i.annualRent, installments)) {
      await u.repo("RentSchedule").create({ id: randomUUID(), leaseId: id, seq: row.seq, dueDate: row.dueDate, amount: fromMinor(row.amountMinor), paidAmount: "0.00", status: "pending" }, { transaction: u.tx });
    }
    if (i.depositAmount && i.depositAmount > 0) await u.repo("SecurityDeposit").create({ id: randomUUID(), leaseId: id, amount: i.depositAmount, status: "pending" }, { transaction: u.tx });
    await u.audit({ action: "lease.created", entityType: "lease", entityId: id, after: { unitId: i.unitId, startsOn: i.startsOn, endsOn: i.endsOn, annualRent: i.annualRent, installments } });
    await u.emit({ type: "lease.created", aggregateType: "lease", aggregateId: id, payload: { unitId: i.unitId, startsOn: i.startsOn, endsOn: i.endsOn } });
    return getLeaseInUow(u, ctx, id);
  });
}

async function scopedLease(u: Uow, ctx: RequestContext, id: string) {
  const scope = await scopeWhere(u, ctx, "lease.read", LEASE_SCOPE);
  const l: any = await u.repo("Lease").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!l) throw new NotFoundError("Lease");
  return l;
}

async function getLeaseInUow(u: Uow, ctx: RequestContext, id: string) {
  const l = await scopedLease(u, ctx, id);
  const [parties, schedule, deposit, addenda] = await Promise.all([
    u.repo("LeaseParty").findAll({ where: { leaseId: id }, transaction: u.tx }),
    u.repo("RentSchedule").findAll({ where: { leaseId: id }, order: [["seq", "ASC"]], transaction: u.tx }),
    u.repo("SecurityDeposit").findOne({ where: { leaseId: id }, transaction: u.tx }),
    u.repo("LeaseAddendum").findAll({ where: { leaseId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
  ]);
  const total = (schedule as any[]).reduce((a, r) => a + toMinor(r.get("amount")), 0);
  const paid = (schedule as any[]).reduce((a, r) => a + toMinor(r.get("paidAmount")), 0);
  return {
    ...plain(l), parties: parties.map(plain), schedule: schedule.map(plain), deposit: deposit ? await depositView(u, deposit) : null, addenda: addenda.map(plain),
    scheduleTotal: fromMinor(total), paidTotal: fromMinor(paid), outstanding: fromMinor(total - paid),
  };
}

async function depositView(u: Uow, d: any) {
  const moves = (await u.repo("DepositMovement").findAll({ where: { depositId: d.get("id") }, order: [["createdAt", "ASC"]], transaction: u.tx })) as any[];
  const held = moves.reduce((a, m) => a + (m.get("kind") === "collect" ? 1 : -1) * toMinor(m.get("amount")), 0);
  return { ...plain(d), held: fromMinor(held), movements: moves.map(plain) };
}

export const getLease = (sq: Sequelize, ctx: RequestContext, id: string) => withUow(sq, ctx, (u) => getLeaseInUow(u, ctx, id));

export async function listLeases(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string; unitId?: string; portfolioId?: string }) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "lease.read", LEASE_SCOPE)];
    if (f.status) and.push({ status: f.status });
    if (f.unitId) and.push({ unitId: f.unitId });
    if (f.portfolioId) and.push({ portfolioId: f.portfolioId });
    return (await u.repo("Lease").findAll({ where: { [Op.and]: and }, order: [["startsOn", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}

export async function attachLeaseDocument(sq: Sequelize, ctx: RequestContext, id: string, documentId: string, registrationRef?: string) {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedLease(u, ctx, id);
    authorize(ctx, "lease.manage", ref(l));
    if (l.get("status") !== "draft") throw new ConflictError("Only a draft lease can change its contract");
    if (!(await u.repo("Document").findById(documentId, { transaction: u.tx }))) throw new NotFoundError("Document");
    await u.repo("Lease").updateById(id, { contractDocumentId: documentId, ...(registrationRef ? { registrationRef } : {}) }, { transaction: u.tx });
    return getLeaseInUow(u, ctx, id);
  });
}

export class LeaseNotActivatableError extends Error {
  status = 422;
  constructor(public reasons: string[]) {
    super("The lease cannot be activated yet");
    this.name = "LeaseNotActivatableError";
  }
}

/** Activation gate, driven by the jurisdiction's lease rule (data, not code): registration reference, a SIGNED contract, deposit. */
export async function activateLease(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedLease(u, ctx, id);
    authorize(ctx, "lease.manage", ref(l));
    if (l.get("status") !== "draft") throw new ConflictError(`A ${l.get("status")} lease cannot be activated`);
    const rule = await resolveLeaseRule(sq, l.get("jurisdictionCode"));
    if (!rule) throw new LeaseNotActivatableError([`No lease rules configured for ${l.get("jurisdictionCode")}`]);
    const r = rule.definition;
    const reasons: string[] = [];
    if (r.requireRegistrationRef && !l.get("registrationRef")) reasons.push(`${r.registrationLabel} registration reference is missing`);
    if (r.requireContractDocument) {
      if (!l.get("contractDocumentId")) reasons.push("No contract document is attached");
      else {
        const signed = await u.repo("SignatureEnvelope").findOne({ where: { documentId: l.get("contractDocumentId"), status: "completed" }, transaction: u.tx });
        if (!signed) reasons.push("The contract has not been signed by all parties");
      }
    }
    if (r.requireDeposit) {
      const d: any = await u.repo("SecurityDeposit").findOne({ where: { leaseId: id }, transaction: u.tx });
      if (!d || d.get("status") !== "held") reasons.push("The security deposit has not been collected");
    }
    if (reasons.length) throw new LeaseNotActivatableError(reasons);
    await u.sq.query("SELECT id FROM units WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: l.get("unitId"), t: ctx.tenantId }, transaction: u.tx });
    await assertNoOverlap(u, l.get("unitId"), l.get("startsOn"), l.get("endsOn"), id);
    await u.repo("Lease").updateById(id, { status: "active", activatedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "lease.activated", entityType: "lease", entityId: id, after: { ruleVersion: rule.ruleVersion } });
    await u.emit({ type: "lease.activated", aggregateType: "lease", aggregateId: id, payload: { unitId: l.get("unitId"), endsOn: l.get("endsOn") } });
    return getLeaseInUow(u, ctx, id);
  });
}

// ---------------------------------------------------------------- rent
const PAYABLE = ["pending", "partial", "overdue"];

/**
 * Record rent received. Allocated to the oldest unpaid instalments first (or to one named instalment), under row locks, so concurrent
 * payments cannot over-allocate. A payment larger than what is owed is refused: surplus handling needs an explicit credit workflow.
 */
export async function recordRentPayment(sq: Sequelize, ctx: RequestContext, leaseId: string, i: { amount: number; method: "bank_transfer" | "cheque" | "cash" | "card"; providerRef?: string; scheduleId?: string; receivedAt?: string }) {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedLease(u, ctx, leaseId);
    authorize(ctx, "rent.record", ref(l));
    if (!["active", "terminated", "ended"].includes(l.get("status"))) throw new ConflictError("Rent can only be recorded against an active (or finished) lease");
    if (!(i.amount > 0)) throw new ConflictError("Payment amount must be positive");
    const payer: any = await u.repo("LeaseParty").findOne({ where: { leaseId, role: "tenant" }, order: [["createdAt", "ASC"]], transaction: u.tx });
    await u.sq.query("SELECT id FROM leases WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: leaseId, t: ctx.tenantId }, transaction: u.tx });
    const rows = (await u.sq.query<any>("SELECT id, seq, amount, paid_amount, status FROM rent_schedules WHERE tenant_id=:t AND lease_id=:l AND status IN ('pending','partial','overdue') ORDER BY seq FOR UPDATE", { replacements: { t: ctx.tenantId, l: leaseId }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    const targets = i.scheduleId ? rows.filter((r) => r.id === i.scheduleId) : rows;
    if (i.scheduleId && !targets.length) throw new ConflictError("That instalment is not payable");
    const owed = targets.reduce((a, r) => a + toMinor(r.amount) - toMinor(r.paid_amount), 0);
    if (toMinor(i.amount) > owed) throw new ConflictError(`The payment (${fromMinor(toMinor(i.amount))}) exceeds the rent owed (${fromMinor(owed)})`);

    const paymentId = await createSucceededPaymentInUow(u, ctx, { contactId: payer.get("contactId"), amount: i.amount, method: i.method, providerRef: i.providerRef, receivedAt: i.receivedAt, currency: l.get("currency") });
    let left = toMinor(i.amount);
    const touched: Array<{ seq: number; amount: string; status: string }> = [];
    for (const r of targets) {
      if (left <= 0) break;
      const due = toMinor(r.amount) - toMinor(r.paid_amount);
      const take = Math.min(due, left);
      left -= take;
      const status = take === due ? "paid" : "partial";
      await u.repo("RentAllocation").create({ id: randomUUID(), paymentId, rentScheduleId: r.id, amount: fromMinor(take), createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
      await u.repo("RentSchedule").updateById(r.id, { paidAmount: fromMinor(toMinor(r.paid_amount) + take), status }, { transaction: u.tx });
      touched.push({ seq: r.seq, amount: fromMinor(take), status });
    }
    await u.emit({ type: "rent.received", aggregateType: "lease", aggregateId: leaseId, payload: { paymentId, amount: fromMinor(toMinor(i.amount)), instalments: touched.length } });
    return { paymentId, allocations: touched, lease: await getLeaseInUow(u, ctx, leaseId) };
  });
}

// ---------------------------------------------------------------- deposits
async function loadDeposit(u: Uow, leaseId: string) {
  const d: any = await u.repo("SecurityDeposit").findOne({ where: { leaseId }, transaction: u.tx });
  if (!d) throw new NotFoundError("Security deposit");
  await u.sq.query("SELECT id FROM security_deposits WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: d.get("id"), t: u.tenantId }, transaction: u.tx });
  return d;
}
const heldMinor = async (u: Uow, depositId: string) =>
  ((await u.repo("DepositMovement").findAll({ where: { depositId }, transaction: u.tx })) as any[]).reduce((a, m) => a + (m.get("kind") === "collect" ? 1 : -1) * toMinor(m.get("amount")), 0);

export async function collectDeposit(sq: Sequelize, ctx: RequestContext, leaseId: string, i: { method: "bank_transfer" | "cheque" | "cash" | "card"; providerRef?: string }) {
  authorize(ctx, "deposit.manage");
  return withUow(sq, ctx, async (u) => {
    const l = await scopedLease(u, ctx, leaseId);
    const d = await loadDeposit(u, leaseId);
    if (d.get("status") !== "pending") throw new ConflictError(`The deposit is already ${d.get("status")}`);
    const payer: any = await u.repo("LeaseParty").findOne({ where: { leaseId, role: "tenant" }, transaction: u.tx });
    const paymentId = await createSucceededPaymentInUow(u, ctx, { contactId: payer.get("contactId"), amount: Number(d.get("amount")), method: i.method, providerRef: i.providerRef, currency: l.get("currency") });
    await u.repo("DepositMovement").create({ id: randomUUID(), depositId: d.get("id"), kind: "collect", amount: d.get("amount"), paymentId, actorId: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.repo("SecurityDeposit").updateById(d.get("id"), { status: "held" }, { transaction: u.tx });
    await u.audit({ action: "deposit.collected", entityType: "lease", entityId: leaseId, after: { amount: d.get("amount") } });
    return getLeaseInUow(u, ctx, leaseId);
  });
}

/** Deductions (damage, arrears) move money away from the tenant's deposit: reason, step-up, audit, and never more than is held. */
export async function deductDeposit(sq: Sequelize, ctx: RequestContext, leaseId: string, i: { amount: number; reason: string }) {
  authorize(ctx, "deposit.manage");
  requireStepUp(ctx);
  if (!i.reason?.trim()) throw new ConflictError("A reason is required");
  if (!(i.amount > 0)) throw new ConflictError("Amount must be positive");
  return withUow(sq, ctx, async (u) => {
    await scopedLease(u, ctx, leaseId);
    const d = await loadDeposit(u, leaseId);
    if (d.get("status") !== "held") throw new ConflictError("The deposit is not held");
    if (toMinor(i.amount) > (await heldMinor(u, d.get("id")))) throw new ConflictError("The deduction exceeds the deposit balance");
    await u.repo("DepositMovement").create({ id: randomUUID(), depositId: d.get("id"), kind: "deduct", amount: i.amount, reason: i.reason.trim(), actorId: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.audit({ action: "deposit.deducted", entityType: "lease", entityId: leaseId, after: { amount: i.amount }, reason: i.reason.trim() });
    return getLeaseInUow(u, ctx, leaseId);
  });
}

/** Refund is only possible once the lease is over, and pays out exactly the remaining balance. */
export async function refundDeposit(sq: Sequelize, ctx: RequestContext, leaseId: string) {
  authorize(ctx, "deposit.manage");
  requireStepUp(ctx);
  return withUow(sq, ctx, async (u) => {
    const l = await scopedLease(u, ctx, leaseId);
    if (!["ended", "terminated"].includes(l.get("status"))) throw new ConflictError("The deposit can only be refunded after the lease has ended");
    const d = await loadDeposit(u, leaseId);
    if (d.get("status") !== "held") throw new ConflictError("The deposit is not held");
    const balance = await heldMinor(u, d.get("id"));
    if (balance > 0) await u.repo("DepositMovement").create({ id: randomUUID(), depositId: d.get("id"), kind: "refund", amount: fromMinor(balance), actorId: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.repo("SecurityDeposit").updateById(d.get("id"), { status: "released" }, { transaction: u.tx });
    await u.audit({ action: "deposit.refunded", entityType: "lease", entityId: leaseId, after: { amount: fromMinor(balance) } });
    return getLeaseInUow(u, ctx, leaseId);
  });
}

// ---------------------------------------------------------------- addenda, termination, renewal
export async function addAddendum(sq: Sequelize, ctx: RequestContext, leaseId: string, i: { title: string; effectiveOn: string; changes?: Record<string, unknown>; documentId?: string }) {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedLease(u, ctx, leaseId);
    authorize(ctx, "lease.manage", ref(l));
    if (!["draft", "active"].includes(l.get("status"))) throw new ConflictError("Addenda apply to draft or active leases");
    if (i.documentId && !(await u.repo("Document").findById(i.documentId, { transaction: u.tx }))) throw new NotFoundError("Document");
    const a = await u.repo("LeaseAddendum").create({ id: randomUUID(), leaseId, title: i.title, effectiveOn: i.effectiveOn, changes: i.changes ?? null, documentId: i.documentId ?? null, createdBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.audit({ action: "lease.addendum_added", entityType: "lease", entityId: leaseId, after: { title: i.title } });
    return plain(a);
  });
}

export async function terminateLease(sq: Sequelize, ctx: RequestContext, leaseId: string, i: { effectiveOn: string; reason: string; noticeGivenOn?: string }) {
  if (!i.reason?.trim()) throw new ConflictError("A reason is required");
  return withUow(sq, ctx, async (u) => {
    const l = await scopedLease(u, ctx, leaseId);
    authorize(ctx, "lease.terminate", ref(l));
    if (l.get("status") !== "active") throw new ConflictError(`A ${l.get("status")} lease cannot be terminated`);
    if (i.effectiveOn < l.get("startsOn") || i.effectiveOn > l.get("endsOn")) throw new ConflictError("The termination date must fall inside the lease term");
    await u.repo("Lease").updateById(leaseId, { status: "terminated", terminatedOn: i.effectiveOn, terminationReason: i.reason.trim(), noticeGivenOn: i.noticeGivenOn ?? null }, { transaction: u.tx });
    // Instalments after the termination date will never fall due; paid or part-paid ones stay as the financial record.
    await u.sq.query("UPDATE rent_schedules SET status='cancelled' WHERE tenant_id=:t AND lease_id=:l AND due_date > :d AND status IN ('pending','overdue')", { replacements: { t: ctx.tenantId, l: leaseId, d: i.effectiveOn }, transaction: u.tx });
    await u.audit({ action: "lease.terminated", entityType: "lease", entityId: leaseId, after: { effectiveOn: i.effectiveOn }, reason: i.reason.trim() });
    await u.emit({ type: "lease.terminated", aggregateType: "lease", aggregateId: leaseId, payload: { unitId: l.get("unitId"), effectiveOn: i.effectiveOn } });
    return getLeaseInUow(u, ctx, leaseId);
  });
}

/** Tenant setting: maximum rent increase (percent) on renewal. Unset means no limit is enforced by the platform. */
async function maxRenewalIncrease(u: Uow): Promise<number | null> {
  const s: any = await u.repo("TenantSetting").findOne({ where: { key: "lease.max_renewal_increase_pct" }, transaction: u.tx });
  const v = s?.get("value");
  return v === null || v === undefined ? null : Number(v);
}

export async function renewLease(sq: Sequelize, ctx: RequestContext, leaseId: string, i: { newAnnualRent: number; newEndsOn?: string; installments?: number; overrideReason?: string }) {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedLease(u, ctx, leaseId);
    authorize(ctx, "lease.manage", ref(l));
    if (l.get("status") !== "active") throw new ConflictError("Only an active lease can be renewed");
    if (await u.repo("Lease").findOne({ where: { previousLeaseId: leaseId }, transaction: u.tx })) throw new ConflictError("This lease has already been renewed");
    const startsOn = addDays(l.get("endsOn"), 1);
    const months = termMonths(l.get("startsOn"), l.get("endsOn"))!;
    const endsOn = i.newEndsOn ?? addDays(addMonths(startsOn, months), -1);
    const old = Number(l.get("annualRent"));
    const pct = ((i.newAnnualRent - old) / old) * 100;
    const limit = await maxRenewalIncrease(u);
    let overridden = false;
    if (limit !== null && pct > limit) {
      authorize(ctx, "lease.terminate", ref(l)); // exceeding the configured cap is a manager decision
      if (!i.overrideReason?.trim()) throw new ConflictError(`The increase (${pct.toFixed(1)}%) exceeds the configured limit (${limit}%); a reason is required`);
      overridden = true;
    }
    const parties = (await u.repo("LeaseParty").findAll({ where: { leaseId }, transaction: u.tx })) as any[];
    const deposit: any = await u.repo("SecurityDeposit").findOne({ where: { leaseId }, transaction: u.tx });
    // Reuse createLease's validation by calling the shared creation path inside this transaction's context.
    const created = await createLeaseInUowFromRenewal(sq, ctx, u, l, parties, deposit, { startsOn, endsOn, annualRent: i.newAnnualRent, installments: i.installments ?? l.get("installments") });
    if (overridden) await u.audit({ action: "lease.renewal_limit_overridden", entityType: "lease", entityId: created.id, after: { increasePct: Number(pct.toFixed(2)), limit }, reason: i.overrideReason });
    await u.emit({ type: "lease.renewal_created", aggregateType: "lease", aggregateId: created.id, payload: { previousLeaseId: leaseId, increasePct: Number(pct.toFixed(2)) } });
    return created;
  });
}

async function createLeaseInUowFromRenewal(sq: Sequelize, ctx: RequestContext, u: Uow, prev: any, parties: any[], deposit: any, n: { startsOn: string; endsOn: string; annualRent: number; installments: number }) {
  const months = termMonths(n.startsOn, n.endsOn);
  if (!months) throw new ConflictError("The renewal term must be a whole number of months");
  await u.sq.query("SELECT id FROM units WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: prev.get("unitId"), t: ctx.tenantId }, transaction: u.tx });
  await assertNoOverlap(u, prev.get("unitId"), n.startsOn, n.endsOn);
  const id = randomUUID();
  await u.repo("Lease").create({
    id, unitId: prev.get("unitId"), portfolioId: prev.get("portfolioId"), branchId: prev.get("branchId"), agentUserId: prev.get("agentUserId"), previousLeaseId: prev.get("id"), status: "draft",
    startsOn: n.startsOn, endsOn: n.endsOn, annualRent: n.annualRent, currency: prev.get("currency"), installments: n.installments, jurisdictionCode: prev.get("jurisdictionCode"), createdBy: ctx.userId,
  }, { transaction: u.tx });
  for (const p of parties.filter((x) => x.get("role") !== "occupant")) await u.repo("LeaseParty").create({ id: randomUUID(), leaseId: id, contactId: p.get("contactId"), role: p.get("role") }, { transaction: u.tx });
  for (const row of buildRentSchedule(n.startsOn, months, n.annualRent, n.installments)) {
    await u.repo("RentSchedule").create({ id: randomUUID(), leaseId: id, seq: row.seq, dueDate: row.dueDate, amount: fromMinor(row.amountMinor), paidAmount: "0.00", status: "pending" }, { transaction: u.tx });
  }
  // The deposit stays with the original lease until move-out; a renewal does not collect it twice.
  void deposit;
  await u.audit({ action: "lease.created", entityType: "lease", entityId: id, after: { renewalOf: prev.get("id"), startsOn: n.startsOn, endsOn: n.endsOn, annualRent: n.annualRent } });
  return getLeaseInUow(u, ctx, id);
}

// ---------------------------------------------------------------- scheduled work (deadlines live in the database)
const EXPIRY_MILESTONES = [90, 60, 30];

export interface LeaseSweepResult { ended: number; overdueMarked: number; expiringNotices: number }

/** Idempotent daily sweep: ends finished leases, flags overdue rent once, and raises 90/60/30-day expiry notices once each. */
export async function leaseSweep(sq: Sequelize, ctx: RequestContext, now = new Date()): Promise<LeaseSweepResult> {
  assertSweepAllowed(ctx, "lease.manage");
  const day = now.toISOString().slice(0, 10);
  return withUow(sq, ctx, async (u) => {
    const out: LeaseSweepResult = { ended: 0, overdueMarked: 0, expiringNotices: 0 };
    const ended = (await u.repo("Lease").findAll({ where: { status: "active", endsOn: { [Op.lt]: day } }, transaction: u.tx })) as any[];
    for (const l of ended) {
      await u.repo("Lease").updateById(l.get("id"), { status: "ended" }, { transaction: u.tx });
      await u.emit({ type: "lease.ended", aggregateType: "lease", aggregateId: l.get("id"), payload: { unitId: l.get("unitId") } });
      out.ended++;
    }
    const overdue = (await u.repo("RentSchedule").findAll({ where: { status: { [Op.in]: ["pending", "partial"] }, dueDate: { [Op.lt]: day } }, transaction: u.tx })) as any[];
    for (const r of overdue) {
      await u.repo("RentSchedule").updateById(r.get("id"), { status: "overdue", overdueNotifiedAt: now }, { transaction: u.tx });
      await u.emit({ type: "rent.overdue", aggregateType: "lease", aggregateId: r.get("leaseId"), payload: { rentScheduleId: r.get("id"), dueDate: r.get("dueDate"), outstanding: fromMinor(toMinor(r.get("amount")) - toMinor(r.get("paidAmount"))) } });
      out.overdueMarked++;
    }
    for (const n of EXPIRY_MILESTONES) {
      const horizon = addDays(day, n);
      const soon = (await u.repo("Lease").findAll({ where: { status: "active", endsOn: { [Op.gte]: day, [Op.lte]: horizon } }, transaction: u.tx })) as any[];
      for (const l of soon) {
        const days = Math.round((Date.parse(l.get("endsOn")) - Date.parse(day)) / 86_400_000);
        const kind = EXPIRY_MILESTONES.filter((m) => days <= m).sort((a, b) => a - b)[0]; // the tightest milestone it has reached
        if (kind !== n) continue;
        try {
          await u.repo("LeaseMilestone").create({ id: randomUUID(), leaseId: l.get("id"), kind: `expiring_${n}`, createdAt: mysqlDate(now) }, { transaction: u.tx });
        } catch (e: any) {
          if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") continue;
          throw e;
        }
        await u.emit({ type: "lease.expiring", aggregateType: "lease", aggregateId: l.get("id"), payload: { daysLeft: days, milestone: n, endsOn: l.get("endsOn") } });
        out.expiringNotices++;
      }
    }
    return out;
  });
}

export async function leaseSweepAllTenants(sq: Sequelize) {
  const tenants = await sq.query<{ id: string }>("SELECT id FROM tenants WHERE status='active'", { type: QueryTypes.SELECT });
  for (const t of tenants) await leaseSweep(sq, systemContext(t.id, `corr_${randomUUID()}`));
}

void can;
