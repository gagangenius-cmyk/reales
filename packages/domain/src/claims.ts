import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { requireStepUp, isApiKeyContext } from "@reales/auth";
import { ForbiddenError, widestScope } from "@reales/rbac";
import { getSetting } from "./config";
import { dubaiDate } from "./hr";
import { nextCounter } from "./finance";
import { fromMinor, toMinor } from "./money";
import { notifyInUow } from "./notifications";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

/**
 * Commission claim batches. Finance gathers approved, unpaid commissions into a batch that must pass maker, checker and approver stages before
 * money is released, with evidence attached and an append-only decision log.
 *
 *   draft -> submitted -> verified -> approved -> scheduled -> released -> (reversed)
 *   rejected / cancelled free the commissions again.
 *
 * Segregation of duties (setting finance.claims.strict_segregation, on by default): the person who submitted cannot verify, the verifier cannot
 * approve, the approver cannot release, and the releaser cannot reverse. With the setting off, the approver still cannot be the person who built the batch.
 */

export type ClaimStatus = "draft" | "submitted" | "verified" | "approved" | "scheduled" | "released" | "rejected" | "cancelled" | "reversed";
export const LIVE_STATUSES: ClaimStatus[] = ["draft", "submitted", "verified", "approved", "scheduled", "released"];

/** Claim permissions are finance-wide: a branch-scoped grant is not enough because a batch spans the company's commissions. */
function need(ctx: RequestContext, permission: string) {
  if (isApiKeyContext(ctx) && ["claim.approve", "claim.release", "claim.reverse"].includes(permission)) throw new ForbiddenError("This action needs a signed-in person");
  if (widestScope(ctx, permission) !== "tenant") throw new ForbiddenError(`Missing permission: ${permission}`);
}

async function lockBatch(u: Uow, ctx: RequestContext, id: string) {
  await u.sq.query("SELECT id FROM commission_claim_batches WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id, t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
  const b: any = await u.repo("ClaimBatch").findById(id, { transaction: u.tx });
  if (!b) throw new NotFoundError("Claim batch");
  return b;
}

async function decide(u: Uow, ctx: RequestContext, batchId: string, stage: string, reason?: string | null) {
  await u.repo("ClaimDecision").create({ id: randomUUID(), batchId, stage, reason: reason?.trim().slice(0, 255) || null, actorId: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
}

async function strict(u: Uow, ctx: RequestContext) { return getSetting<boolean>(u.sq, ctx.tenantId, "finance.claims.strict_segregation"); }

/** Four-eyes rule. `others` are the people this actor must differ from, with the stage they acted at (for the message). */
async function assertDifferent(u: Uow, ctx: RequestContext, others: [string, string | null][], minimum?: string[]) {
  const strictMode = await strict(u, ctx);
  for (const [what, who] of others) {
    if (!who || who !== ctx.userId) continue;
    if (strictMode || (minimum ?? []).includes(what)) throw new ForbiddenError(`Segregation of duties: you ${what}, so someone else must do this step`);
  }
}

async function recalc(u: Uow, ctx: RequestContext, batchId: string) {
  const items = (await u.repo("ClaimItem").findAll({ where: { batchId, live: 1 }, transaction: u.tx })) as any[];
  const amount = items.reduce((a, i) => a + toMinor(i.get("amount")), 0), vat = items.reduce((a, i) => a + toMinor(i.get("vatAmount")), 0);
  await u.repo("ClaimBatch").updateById(batchId, { amount: fromMinor(amount), vatAmount: fromMinor(vat), itemCount: items.length }, { transaction: u.tx });
}

/** Release the commissions of a batch that will not proceed, so they can be claimed or requested again. */
async function freeItems(u: Uow, batchId: string) {
  await u.repo("ClaimItem").updateWhere({ batchId, live: 1 }, { live: null }, { transaction: u.tx });
}

// ---------------------------------------------------------------- candidates

/** Approved commissions nobody has paid, claimed or requested yet. */
export async function listClaimCandidates(sq: Sequelize, ctx: RequestContext) {
  need(ctx, "claim.create");
  return withUow(sq, ctx, async (u) => {
    const rows = await u.sq.query<any>(
      `SELECT c.id, c.deal_id, c.agent_user_id, c.commission_amount, c.vat_amount, c.currency, c.approved_at, usr.email AS agent_email
         FROM commission_calculations c LEFT JOIN users usr ON usr.id = c.agent_user_id AND usr.tenant_id = c.tenant_id
        WHERE c.tenant_id = :t AND c.status = 'approved' AND c.paid_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM commission_claim_items i WHERE i.tenant_id = c.tenant_id AND i.calculation_id = c.id AND i.live = 1)
          AND NOT EXISTS (SELECT 1 FROM payout_request_items p JOIN payout_requests r ON r.id = p.request_id AND r.tenant_id = p.tenant_id WHERE p.tenant_id = c.tenant_id AND p.calculation_id = c.id AND p.active = 1 AND r.status NOT IN ('rejected','cancelled'))
        ORDER BY c.approved_at ASC LIMIT 500`,
      { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT },
    );
    return rows.map((r) => ({ id: r.id, dealId: r.deal_id, agentUserId: r.agent_user_id, agentEmail: r.agent_email, amount: String(r.commission_amount), vatAmount: String(r.vat_amount), currency: r.currency, approvedAt: r.approved_at }));
  });
}

// ---------------------------------------------------------------- build

async function addItems(u: Uow, ctx: RequestContext, batch: any, ids: string[]) {
  const unique = [...new Set(ids)];
  const free = new Set((await listCandidatesIn(u, ctx)).map((c) => c.id));
  const calcs = (await u.repo("CommissionCalculation").findAll({ where: { id: { [Op.in]: unique } }, transaction: u.tx })) as any[];
  if (calcs.length !== unique.length) throw new NotFoundError("Commission");
  for (const c of calcs) {
    if (!free.has(c.get("id"))) throw new ConflictError("One of those commissions is not available to claim (not approved, already paid, requested or in another batch)");
    const cur = batch.get("currency");
    if (cur && cur !== c.get("currency")) throw new ConflictError("A batch holds one currency");
    batch.set("currency", c.get("currency"));
  }
  if (new Set(calcs.map((c) => c.get("currency"))).size > 1) throw new ConflictError("A batch holds one currency");
  for (const c of calcs) {
    try {
      await u.repo("ClaimItem").create({ id: randomUUID(), batchId: batch.get("id"), calculationId: c.get("id"), payeeUserId: c.get("agentUserId") ?? null, amount: c.get("commissionAmount"), vatAmount: c.get("vatAmount") ?? "0.00", currency: c.get("currency"), live: 1, verification: "pending" }, { transaction: u.tx });
    } catch (e: any) {
      if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") throw new ConflictError("A commission was claimed by someone else at the same moment");
      throw e;
    }
  }
  await u.repo("ClaimBatch").updateById(batch.get("id"), { currency: batch.get("currency") }, { transaction: u.tx });
  await recalc(u, ctx, batch.get("id"));
}
async function listCandidatesIn(u: Uow, ctx: RequestContext) {
  const rows = await u.sq.query<{ id: string }>(
    `SELECT c.id FROM commission_calculations c WHERE c.tenant_id = :t AND c.status='approved' AND c.paid_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM commission_claim_items i WHERE i.tenant_id=c.tenant_id AND i.calculation_id=c.id AND i.live=1)
        AND NOT EXISTS (SELECT 1 FROM payout_request_items p JOIN payout_requests r ON r.id=p.request_id AND r.tenant_id=p.tenant_id WHERE p.tenant_id=c.tenant_id AND p.calculation_id=c.id AND p.active=1 AND r.status NOT IN ('rejected','cancelled'))`,
    { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT },
  );
  return rows;
}

export async function createClaimBatch(sq: Sequelize, ctx: RequestContext, i: { title?: string; calculationIds: string[]; notes?: string }) {
  need(ctx, "claim.create");
  if (!i.calculationIds?.length) throw new ConflictError("Choose at least one commission");
  return withUow(sq, ctx, async (u) => {
    // The batch takes its currency from the first commission (the column is required); addItems then enforces one currency.
    const first: any = await u.repo("CommissionCalculation").findById(i.calculationIds[0]!, { transaction: u.tx });
    if (!first) throw new NotFoundError("Commission");
    const id = randomUUID();
    const number = await nextCounter(u, ctx.tenantId, "claim_batch");
    await u.repo("ClaimBatch").create({ id, number, title: i.title?.trim().slice(0, 160) || `Claim batch ${number}`, status: "draft", currency: first.get("currency"), amount: "0.00", vatAmount: "0.00", itemCount: 0, notes: i.notes?.trim().slice(0, 500) || null, createdBy: ctx.userId }, { transaction: u.tx });
    const batch: any = await u.repo("ClaimBatch").findById(id, { transaction: u.tx });
    await addItems(u, ctx, batch, i.calculationIds);
    await u.audit({ action: "claim.created", entityType: "claim_batch", entityId: id, after: { number, items: i.calculationIds.length } });
    return plain(await u.repo("ClaimBatch").findById(id, { transaction: u.tx }));
  });
}

export async function addClaimItems(sq: Sequelize, ctx: RequestContext, batchId: string, calculationIds: string[]) {
  need(ctx, "claim.create");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, batchId);
    if (b.get("status") !== "draft") throw new ConflictError("Items can only be changed while the batch is a draft");
    await addItems(u, ctx, b, calculationIds);
    await u.audit({ action: "claim.items_added", entityType: "claim_batch", entityId: batchId, after: { count: calculationIds.length } });
    return plain(await u.repo("ClaimBatch").findById(batchId, { transaction: u.tx }));
  });
}

export async function removeClaimItem(sq: Sequelize, ctx: RequestContext, batchId: string, itemId: string) {
  need(ctx, "claim.create");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, batchId);
    if (b.get("status") !== "draft") throw new ConflictError("Items can only be changed while the batch is a draft");
    const it: any = await u.repo("ClaimItem").findOne({ where: { id: itemId, batchId, live: 1 }, transaction: u.tx });
    if (!it) throw new NotFoundError("Claim item");
    await u.repo("ClaimItem").updateById(itemId, { live: null }, { transaction: u.tx });
    await recalc(u, ctx, batchId);
    await u.audit({ action: "claim.item_removed", entityType: "claim_batch", entityId: batchId, after: { calculationId: it.get("calculationId") } });
  });
}

export async function addClaimEvidence(sq: Sequelize, ctx: RequestContext, batchId: string, i: { kind: "bank_statement" | "invoice" | "contract" | "email" | "other"; description: string; documentId?: string | null; itemId?: string | null }) {
  need(ctx, "claim.create");
  if (!i.description.trim()) throw new ConflictError("Describe the evidence");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, batchId);
    if (!["draft", "submitted", "verified"].includes(b.get("status"))) throw new ConflictError("Evidence can no longer be added at this stage");
    if (i.documentId && !(await u.repo("Document").findById(i.documentId, { transaction: u.tx }))) throw new NotFoundError("Document");
    if (i.itemId && !(await u.repo("ClaimItem").findOne({ where: { id: i.itemId, batchId }, transaction: u.tx }))) throw new NotFoundError("Claim item");
    const id = randomUUID();
    await u.repo("ClaimEvidence").create({ id, batchId, itemId: i.itemId ?? null, kind: i.kind, description: i.description.trim().slice(0, 300), documentId: i.documentId ?? null, addedBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: "claim.evidence_added", entityType: "claim_batch", entityId: batchId, after: { kind: i.kind } });
    return plain(await u.repo("ClaimEvidence").findById(id, { transaction: u.tx }));
  });
}

// ---------------------------------------------------------------- stages

async function holders(u: Uow, tenantId: string, permission: string): Promise<string[]> {
  const rows = await u.sq.query<{ user_id: string }>(
    "SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id AND rp.tenant_id=ur.tenant_id JOIN permissions p ON p.id=rp.permission_id JOIN users x ON x.id=ur.user_id AND x.tenant_id=ur.tenant_id WHERE ur.tenant_id=:t AND p.`key`=:p AND x.status='active'",
    { replacements: { t: tenantId, p: permission }, transaction: u.tx, type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.user_id);
}
async function tell(u: Uow, ctx: RequestContext, batch: any, permission: string, kind: string, title: string) {
  for (const to of await holders(u, ctx.tenantId, permission)) if (to !== ctx.userId) await notifyInUow(u, { userId: to, kind, title, body: `Claim batch ${batch.get("number")}: ${batch.get("currency")} ${batch.get("amount")}`, entityType: "claim_batch", entityId: batch.get("id"), dedupeKey: `${kind}:${batch.get("id")}:${to}` });
}

export async function submitClaimBatch(sq: Sequelize, ctx: RequestContext, id: string) {
  need(ctx, "claim.create");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, id);
    if (b.get("status") !== "draft") throw new ConflictError(`A ${b.get("status")} batch cannot be submitted`);
    if (b.get("createdBy") !== ctx.userId) throw new ForbiddenError("Only the person who built the batch can submit it");
    if (!b.get("itemCount")) throw new ConflictError("Add at least one commission before submitting");
    await u.repo("ClaimBatch").updateById(id, { status: "submitted", submittedBy: ctx.userId, submittedAt: new Date() }, { transaction: u.tx });
    await decide(u, ctx, id, "submit");
    await tell(u, ctx, b, "claim.verify", "claim.submitted", "A claim batch needs verification");
    await u.audit({ action: "claim.submitted", entityType: "claim_batch", entityId: id });
    await u.emit({ type: "claim.submitted", aggregateType: "claim_batch", aggregateId: id, payload: { number: b.get("number"), amount: b.get("amount"), currency: b.get("currency") } });
    return plain(await u.repo("ClaimBatch").findById(id, { transaction: u.tx }));
  });
}

/** The checker looks at each commission: verified, or flagged with a note. A flagged item blocks the batch until it is removed (reject the batch to rework it). */
export async function verifyClaimItem(sq: Sequelize, ctx: RequestContext, batchId: string, itemId: string, i: { outcome: "verified" | "flagged"; note?: string }) {
  need(ctx, "claim.verify");
  if (i.outcome === "flagged" && !i.note?.trim()) throw new ConflictError("Say what is wrong with a flagged item");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, batchId);
    if (b.get("status") !== "submitted") throw new ConflictError("Items can be checked only while the batch is submitted");
    await assertDifferent(u, ctx, [["submitted this batch", b.get("submittedBy")]], ["submitted this batch"]);
    const it: any = await u.repo("ClaimItem").findOne({ where: { id: itemId, batchId, live: 1 }, transaction: u.tx });
    if (!it) throw new NotFoundError("Claim item");
    await u.repo("ClaimItem").updateById(itemId, { verification: i.outcome, verificationNote: i.note?.trim().slice(0, 255) || null, verifiedBy: ctx.userId, verifiedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: `claim.item_${i.outcome}`, entityType: "claim_batch", entityId: batchId, after: { itemId, note: i.note } });
    return plain(await u.repo("ClaimItem").findById(itemId, { transaction: u.tx }));
  });
}

export async function verifyClaimBatch(sq: Sequelize, ctx: RequestContext, id: string) {
  need(ctx, "claim.verify");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, id);
    if (b.get("status") !== "submitted") throw new ConflictError(`A ${b.get("status")} batch cannot be verified`);
    await assertDifferent(u, ctx, [["submitted this batch", b.get("submittedBy")]], ["submitted this batch"]);
    const items = (await u.repo("ClaimItem").findAll({ where: { batchId: id, live: 1 }, transaction: u.tx })) as any[];
    const open = items.filter((x) => x.get("verification") !== "verified");
    if (open.length) throw new ConflictError(`${open.length} item(s) are not verified yet or are flagged`);
    if ((await u.repo("ClaimEvidence").count({ where: { batchId: id }, transaction: u.tx })) < 1) throw new ConflictError("Attach at least one piece of evidence before verifying");
    await u.repo("ClaimBatch").updateById(id, { status: "verified", verifiedBy: ctx.userId, verifiedAt: new Date() }, { transaction: u.tx });
    await decide(u, ctx, id, "verify");
    await tell(u, ctx, b, "claim.approve", "claim.verified", "A claim batch needs approval");
    await u.audit({ action: "claim.verified", entityType: "claim_batch", entityId: id });
    return plain(await u.repo("ClaimBatch").findById(id, { transaction: u.tx }));
  });
}

/** Send a batch back: the checker (while submitted) or the approver (while verified). Frees every commission. */
export async function rejectClaimBatch(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  if (!reason.trim()) throw new ConflictError("A reason is required to reject a batch");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, id);
    const st = b.get("status");
    if (st === "submitted") need(ctx, "claim.verify");
    else if (st === "verified") need(ctx, "claim.approve");
    else throw new ConflictError(`A ${st} batch cannot be rejected`);
    await u.repo("ClaimBatch").updateById(id, { status: "rejected", rejectionReason: reason.trim().slice(0, 255) }, { transaction: u.tx });
    await freeItems(u, id);
    await decide(u, ctx, id, "reject", reason);
    if (b.get("createdBy") !== ctx.userId) await notifyInUow(u, { userId: b.get("createdBy"), kind: "claim.rejected", title: "Your claim batch was rejected", body: reason.trim().slice(0, 200), entityType: "claim_batch", entityId: id, dedupeKey: `claim-rejected:${id}` });
    await u.audit({ action: "claim.rejected", entityType: "claim_batch", entityId: id, reason });
    return plain(await u.repo("ClaimBatch").findById(id, { transaction: u.tx }));
  });
}

export async function cancelClaimBatch(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  need(ctx, "claim.create");
  if (!reason.trim()) throw new ConflictError("A reason is required");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, id);
    if (!["draft", "submitted"].includes(b.get("status"))) throw new ConflictError(`A ${b.get("status")} batch cannot be cancelled`);
    if (b.get("createdBy") !== ctx.userId) throw new ForbiddenError("Only the person who built the batch can cancel it");
    await u.repo("ClaimBatch").updateById(id, { status: "cancelled", rejectionReason: reason.trim().slice(0, 255) }, { transaction: u.tx });
    await freeItems(u, id);
    await decide(u, ctx, id, "cancel", reason);
    await u.audit({ action: "claim.cancelled", entityType: "claim_batch", entityId: id, reason });
    return plain(await u.repo("ClaimBatch").findById(id, { transaction: u.tx }));
  });
}

export async function approveClaimBatch(sq: Sequelize, ctx: RequestContext, id: string) {
  need(ctx, "claim.approve");
  requireStepUp(ctx);
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, id);
    if (b.get("status") !== "verified") throw new ConflictError(`A ${b.get("status")} batch cannot be approved`);
    await assertDifferent(u, ctx, [["built this batch", b.get("createdBy")], ["verified this batch", b.get("verifiedBy")]], ["built this batch"]);
    await u.repo("ClaimBatch").updateById(id, { status: "approved", approvedBy: ctx.userId, approvedAt: new Date() }, { transaction: u.tx });
    await decide(u, ctx, id, "approve");
    await u.audit({ action: "claim.approved", entityType: "claim_batch", entityId: id, after: { amount: b.get("amount"), currency: b.get("currency") } });
    await u.emit({ type: "claim.approved", aggregateType: "claim_batch", aggregateId: id, payload: { number: b.get("number"), amount: b.get("amount"), currency: b.get("currency") } });
    return plain(await u.repo("ClaimBatch").findById(id, { transaction: u.tx }));
  });
}

/** Pick the release date (Dubai calendar, not in the past). Can be moved until the batch is released. */
export async function scheduleClaimRelease(sq: Sequelize, ctx: RequestContext, id: string, date: string) {
  need(ctx, "claim.approve");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new ConflictError("Invalid release date");
  if (date < dubaiDate()) throw new ConflictError("The release date cannot be in the past");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, id);
    if (!["approved", "scheduled"].includes(b.get("status"))) throw new ConflictError("Only an approved batch can be scheduled");
    await u.repo("ClaimBatch").updateById(id, { status: "scheduled", scheduledFor: date, scheduledBy: ctx.userId }, { transaction: u.tx });
    await decide(u, ctx, id, "schedule", date);
    await tell(u, ctx, b, "claim.release", "claim.scheduled", `A claim batch is scheduled for release on ${date}`);
    await u.audit({ action: "claim.scheduled", entityType: "claim_batch", entityId: id, after: { date } });
    return plain(await u.repo("ClaimBatch").findById(id, { transaction: u.tx }));
  });
}

/** Pay out: every commission in the batch is marked paid with the bank reference, in one transaction. Only on or after the scheduled date. */
export async function releaseClaimBatch(sq: Sequelize, ctx: RequestContext, id: string, reference: string) {
  need(ctx, "claim.release");
  requireStepUp(ctx);
  if (!reference.trim()) throw new ConflictError("A payment reference is required");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, id);
    if (b.get("status") !== "scheduled") throw new ConflictError(b.get("status") === "approved" ? "Schedule the release date first" : `A ${b.get("status")} batch cannot be released`);
    if (String(b.get("scheduledFor")) > dubaiDate()) throw new ConflictError(`This batch is scheduled for ${b.get("scheduledFor")} and cannot be released earlier`);
    await assertDifferent(u, ctx, [["built this batch", b.get("createdBy")], ["approved this batch", b.get("approvedBy")]], ["approved this batch", "built this batch"]);
    const items = (await u.repo("ClaimItem").findAll({ where: { batchId: id, live: 1 }, transaction: u.tx })) as any[];
    const now = new Date();
    for (const it of items) {
      const c: any = await u.repo("CommissionCalculation").findById(it.get("calculationId"), { transaction: u.tx });
      if (!c || c.get("paidAt") || c.get("status") !== "approved") throw new ConflictError("A commission in this batch changed since it was approved; reject the batch and rebuild it");
      await u.repo("CommissionCalculation").updateById(c.get("id"), { paidAt: now, paidBy: ctx.userId, paidReference: reference.trim().slice(0, 120) }, { transaction: u.tx });
      await u.emit({ type: "commission.paid", aggregateType: "deal", aggregateId: c.get("dealId"), payload: { calculationId: c.get("id"), claimBatchId: id } });
    }
    await u.repo("ClaimBatch").updateById(id, { status: "released", releasedBy: ctx.userId, releasedAt: now, releaseReference: reference.trim().slice(0, 120) }, { transaction: u.tx });
    await decide(u, ctx, id, "release", reference);
    await u.audit({ action: "claim.released", entityType: "claim_batch", entityId: id, after: { reference: reference.trim(), amount: b.get("amount"), items: items.length } });
    await u.emit({ type: "claim.released", aggregateType: "claim_batch", aggregateId: id, payload: { number: b.get("number"), amount: b.get("amount"), currency: b.get("currency"), reference: reference.trim() } });
    return plain(await u.repo("ClaimBatch").findById(id, { transaction: u.tx }));
  });
}

/** Undo a release (a bank return, a wrong reference): the commissions become unpaid again and can be claimed or requested anew. */
export async function reverseClaimBatch(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  need(ctx, "claim.reverse");
  requireStepUp(ctx);
  if (!reason.trim()) throw new ConflictError("A reason is required to reverse a release");
  return withUow(sq, ctx, async (u) => {
    const b = await lockBatch(u, ctx, id);
    if (b.get("status") !== "released") throw new ConflictError("Only a released batch can be reversed");
    await assertDifferent(u, ctx, [["released this batch", b.get("releasedBy")]], ["released this batch"]);
    const items = (await u.repo("ClaimItem").findAll({ where: { batchId: id, live: 1 }, transaction: u.tx })) as any[];
    for (const it of items) {
      await u.repo("CommissionCalculation").updateById(it.get("calculationId"), { paidAt: null, paidBy: null, paidReference: null }, { transaction: u.tx });
      await u.emit({ type: "commission.payment_reversed", aggregateType: "deal", aggregateId: (await u.repo("CommissionCalculation").findById(it.get("calculationId"), { transaction: u.tx }) as any).get("dealId"), payload: { calculationId: it.get("calculationId"), claimBatchId: id } });
    }
    await freeItems(u, id);
    await u.repo("ClaimBatch").updateById(id, { status: "reversed", reversedBy: ctx.userId, reversedAt: new Date(), reversalReason: reason.trim().slice(0, 255) }, { transaction: u.tx });
    await decide(u, ctx, id, "reverse", reason);
    await u.audit({ action: "claim.reversed", entityType: "claim_batch", entityId: id, reason, after: { items: items.length } });
    await u.emit({ type: "claim.reversed", aggregateType: "claim_batch", aggregateId: id, payload: { number: b.get("number"), reason: reason.trim() } });
    return plain(await u.repo("ClaimBatch").findById(id, { transaction: u.tx }));
  });
}

// ---------------------------------------------------------------- reads and sweep

export async function listClaimBatches(sq: Sequelize, ctx: RequestContext, f: { status?: ClaimStatus; limit?: number } = {}) {
  need(ctx, "claim.read");
  return withUow(sq, ctx, async (u) => (await u.repo("ClaimBatch").findAll({ where: f.status ? { status: f.status } : {}, order: [["number", "DESC"]], limit: Math.min(f.limit ?? 100, 300), transaction: u.tx })).map(plain));
}

export async function getClaimBatch(sq: Sequelize, ctx: RequestContext, id: string) {
  need(ctx, "claim.read");
  return withUow(sq, ctx, async (u) => {
    const b: any = await u.repo("ClaimBatch").findById(id, { transaction: u.tx });
    if (!b) throw new NotFoundError("Claim batch");
    const [items, evidence, decisions] = await Promise.all([
      u.repo("ClaimItem").findAll({ where: { batchId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
      u.repo("ClaimEvidence").findAll({ where: { batchId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
      u.repo("ClaimDecision").findAll({ where: { batchId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
    ]);
    const ids = [...new Set([...(items as any[]).map((i) => i.get("payeeUserId")), ...(decisions as any[]).map((d) => d.get("actorId"))].filter(Boolean))];
    const users = (await u.repo("User").findAll({ where: { id: { [Op.in]: ids.concat(["-"]) } }, attributes: ["id", "email"], transaction: u.tx })) as any[];
    const email = new Map(users.map((x) => [x.get("id"), x.get("email") as string]));
    return {
      ...plain(b),
      items: (items as any[]).map((i) => ({ ...plain(i), payeeEmail: email.get(i.get("payeeUserId")) ?? null })),
      evidence: (evidence as any[]).map(plain),
      decisions: (decisions as any[]).map((d) => ({ ...plain(d), actorEmail: email.get(d.get("actorId")) ?? null })),
    };
  });
}

/** Tell the releasers once when a scheduled batch has reached its date. Idempotent (dedupe key per batch and person). */
export async function claimReleaseDueSweep(sq: Sequelize, ctx: RequestContext): Promise<number> {
  return withUow(sq, ctx, async (u) => {
    const due = (await u.repo("ClaimBatch").findAll({ where: { status: "scheduled", scheduledFor: { [Op.lte]: dubaiDate() } }, transaction: u.tx })) as any[];
    let n = 0;
    for (const b of due) for (const to of await holders(u, ctx.tenantId, "claim.release")) if (await notifyInUow(u, { userId: to, kind: "claim.due", title: `Claim batch ${b.get("number")} is due for release today`, body: `${b.get("currency")} ${b.get("amount")}`, entityType: "claim_batch", entityId: b.get("id"), dedupeKey: `claim-due:${b.get("id")}:${to}` })) n++;
    return n;
  });
}
