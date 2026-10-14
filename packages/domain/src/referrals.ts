import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { RequestContext } from "@reales/database";
import { requireStepUp } from "@reales/auth";
import { authorize, hasPermission, ForbiddenError } from "@reales/rbac";
import { LEAD_SCOPE } from "./leads";
import { fromMinor, toMinor } from "./money";
import { plain, scopeWhere } from "./scope";
import { assertSweepAllowed, ConflictError, NotFoundError, Uow, withUow } from "./uow";

export async function createPartner(sq: Sequelize, ctx: RequestContext, i: { name: string; kind: "broker" | "developer" | "bank" | "corporate" | "individual"; feePct: number; contactId?: string }) {
  authorize(ctx, "referral.manage");
  if (!(i.feePct >= 0 && i.feePct <= 100)) throw new ConflictError("Fee must be between 0 and 100 percent");
  return withUow(sq, ctx, async (u) => {
    if (await u.repo("ReferralPartner").findOne({ where: { name: i.name }, transaction: u.tx })) throw new ConflictError("A partner with this name exists");
    if (i.contactId && !(await u.repo("Contact").findById(i.contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    const p = await u.repo("ReferralPartner").create({ id: randomUUID(), name: i.name, kind: i.kind, feePct: i.feePct, contactId: i.contactId ?? null, status: "active" }, { transaction: u.tx });
    await u.audit({ action: "referral.partner_created", entityType: "referral_partner", entityId: (p as any).get("id"), after: { name: i.name, feePct: i.feePct } });
    return plain(p);
  });
}

export async function listPartners(sq: Sequelize, ctx: RequestContext) {
  if (!hasPermission(ctx, "referral.read")) throw new ForbiddenError("Missing permission: referral.read");
  return withUow(sq, ctx, async (u) => (await u.repo("ReferralPartner").findAll({ order: [["name", "ASC"]], transaction: u.tx })).map(plain));
}

export async function setPartnerStatus(sq: Sequelize, ctx: RequestContext, id: string, status: "active" | "inactive") {
  authorize(ctx, "referral.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("ReferralPartner").findById(id, { transaction: u.tx }))) throw new NotFoundError("Partner");
    await u.repo("ReferralPartner").updateById(id, { status }, { transaction: u.tx });
    return plain(await u.repo("ReferralPartner").findById(id, { transaction: u.tx }));
  });
}

/** One referral per lead. The fee percentage is frozen at referral time, so later partner changes never alter an agreed fee. */
export async function referLead(sq: Sequelize, ctx: RequestContext, i: { partnerId: string; leadId: string; note?: string }) {
  authorize(ctx, "referral.manage");
  return withUow(sq, ctx, async (u) => {
    const partner: any = await u.repo("ReferralPartner").findById(i.partnerId, { transaction: u.tx });
    if (!partner) throw new NotFoundError("Partner");
    if (partner.get("status") !== "active") throw new ConflictError("The partner is inactive");
    const scope = await scopeWhere(u, ctx, "referral.manage", LEAD_SCOPE);
    if (!(await u.repo("Lead").findOne({ where: { [Op.and]: [{ id: i.leadId }, scope] }, transaction: u.tx }))) throw new NotFoundError("Lead");
    try {
      const r = await u.repo("Referral").create({ id: randomUUID(), partnerId: i.partnerId, leadId: i.leadId, feePct: partner.get("feePct"), status: "submitted", currency: "AED", note: i.note ?? null }, { transaction: u.tx });
      await u.audit({ action: "referral.created", entityType: "lead", entityId: i.leadId, after: { partnerId: i.partnerId, feePct: partner.get("feePct") } });
      return plain(r);
    } catch (e: any) {
      if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") throw new ConflictError("This lead already has a referral");
      throw e;
    }
  });
}

export async function listReferrals(sq: Sequelize, ctx: RequestContext, f: { status?: string; partnerId?: string; limit: number; offset: number }) {
  if (!hasPermission(ctx, "referral.read")) throw new ForbiddenError("Missing permission: referral.read");
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "referral.read", LEAD_SCOPE);
    const leadIds = ((await u.repo("Lead").findAll({ where: scope, attributes: ["id"], transaction: u.tx })) as any[]).map((l) => l.get("id"));
    const where: any = { leadId: { [Op.in]: leadIds.length ? leadIds : ["-"] }, ...(f.status ? { status: f.status } : {}), ...(f.partnerId ? { partnerId: f.partnerId } : {}) };
    return (await u.repo("Referral").findAll({ where, order: [["createdAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}

/** Fee = the commission earned on the closed deal x the frozen percentage. No commission calculation yet means nothing to settle. */
async function settleOne(u: Uow, r: any): Promise<boolean> {
  const deal: any = await u.repo("Deal").findOne({ where: { leadId: r.get("leadId"), status: "closed" }, transaction: u.tx });
  if (!deal) return false;
  const rows = await u.sq.query<any>("SELECT COALESCE(SUM(commission_amount),0) c FROM commission_calculations WHERE tenant_id=:t AND deal_id=:d", { replacements: { t: u.tenantId, d: deal.get("id") }, transaction: u.tx, type: QueryTypes.SELECT });
  const commission = toMinor(rows[0]?.c);
  if (commission <= 0) return false;
  const fee = Math.round((commission * Number(r.get("feePct"))) / 100);
  await u.repo("Referral").updateById(r.get("id"), { status: "won", dealId: deal.get("id"), feeAmount: fromMinor(fee), currency: deal.get("currency"), settledAt: new Date() }, { transaction: u.tx });
  await u.emit({ type: "referral.won", aggregateType: "referral", aggregateId: r.get("id"), payload: { feeAmount: fromMinor(fee), dealId: deal.get("id") } });
  return true;
}

export async function settleReferral(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "referral.settle");
  return withUow(sq, ctx, async (u) => {
    const r: any = await u.repo("Referral").findById(id, { transaction: u.tx });
    if (!r) throw new NotFoundError("Referral");
    if (r.get("status") !== "submitted") throw new ConflictError(`A ${r.get("status")} referral cannot be settled`);
    if (!(await settleOne(u, r))) throw new ConflictError("The referred lead has no closed deal with a calculated commission yet");
    await u.audit({ action: "referral.settled", entityType: "referral", entityId: id });
    return plain(await u.repo("Referral").findById(id, { transaction: u.tx }));
  });
}

export async function markReferralPaid(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "referral.settle");
  requireStepUp(ctx);
  return withUow(sq, ctx, async (u) => {
    const r: any = await u.repo("Referral").findById(id, { transaction: u.tx });
    if (!r) throw new NotFoundError("Referral");
    if (r.get("status") !== "won") throw new ConflictError("Only a settled (won) referral can be paid");
    await u.repo("Referral").updateById(id, { status: "paid", paidAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "referral.paid", entityType: "referral", entityId: id, after: { feeAmount: r.get("feeAmount") } });
    return plain(await u.repo("Referral").findById(id, { transaction: u.tx }));
  });
}

export async function voidReferral(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  authorize(ctx, "referral.manage");
  if (!reason?.trim()) throw new ConflictError("A reason is required");
  return withUow(sq, ctx, async (u) => {
    const r: any = await u.repo("Referral").findById(id, { transaction: u.tx });
    if (!r) throw new NotFoundError("Referral");
    if (r.get("status") === "paid") throw new ConflictError("A paid referral cannot be voided");
    await u.repo("Referral").updateById(id, { status: "void", note: reason.trim() }, { transaction: u.tx });
    await u.audit({ action: "referral.voided", entityType: "referral", entityId: id, reason: reason.trim() });
    return plain(await u.repo("Referral").findById(id, { transaction: u.tx }));
  });
}

/** Sweep: settle every submitted referral whose lead has since closed a deal with a commission. Payment still needs a human (referral.settle + step-up). */
export async function settleDueReferrals(sq: Sequelize, ctx: RequestContext) {
  assertSweepAllowed(ctx, "referral.settle");
  return withUow(sq, ctx, async (u) => {
    let n = 0;
    for (const r of (await u.repo("Referral").findAll({ where: { status: "submitted" }, limit: 500, transaction: u.tx })) as any[]) if (await settleOne(u, r)) n++;
    return n;
  });
}
