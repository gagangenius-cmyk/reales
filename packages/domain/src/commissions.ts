import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { requireStepUp } from "@reales/auth";
import { authorize } from "@reales/rbac";
import { getAgentProfileIn } from "./agents";
import { allocateByPct, fromMinor, toMinor } from "./money";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export interface CommissionSplitInput { role: string; pct: number }

/**
 * A slab applies once the agent's closed deal value in the calendar year (Dubai) reaches `fromValue`. It can raise the commission rate charged on
 * the deal, the agent's share of that commission, or both. The slab reached BEFORE the deal applies to the whole deal (not marginal).
 */
export interface CommissionSlab { fromValue: number; ratePct?: number; agentSharePct?: number; label?: string }

export function validateSlabs(slabs: CommissionSlab[] | undefined | null): CommissionSlab[] {
  if (!slabs?.length) return [];
  const sorted = [...slabs].sort((a, b) => a.fromValue - b.fromValue);
  if (sorted[0]!.fromValue !== 0) throw new ConflictError("The first slab must start at 0");
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    if (!(s.fromValue >= 0)) throw new ConflictError("Slab thresholds must be zero or more");
    if (i > 0 && s.fromValue === sorted[i - 1]!.fromValue) throw new ConflictError("Two slabs start at the same value");
    if (s.ratePct === undefined && s.agentSharePct === undefined) throw new ConflictError("Each slab must change the rate, the agent's share, or both");
    if (s.ratePct !== undefined && !(s.ratePct > 0 && s.ratePct <= 100)) throw new ConflictError("A slab rate must be between 0 and 100 percent");
    if (s.agentSharePct !== undefined && !(s.agentSharePct > 0 && s.agentSharePct <= 100)) throw new ConflictError("A slab agent share must be between 0 and 100 percent");
  }
  return sorted;
}

/** Pick the slab for a given year-to-date value and re-balance the split so it still adds up to 100%. Pure function (unit-tested). */
export function applySlab(basePct: number, splits: CommissionSplitInput[], slabs: CommissionSlab[], ytd: number) {
  const slab = [...slabs].sort((a, b) => a.fromValue - b.fromValue).filter((s) => s.fromValue <= ytd).pop() ?? null;
  const ratePct = slab?.ratePct ?? basePct;
  let out = splits.map((s) => ({ ...s }));
  if (slab?.agentSharePct !== undefined) {
    const agent = slab.agentSharePct;
    const others = out.filter((s) => s.role !== "agent");
    const otherTotal = others.reduce((a, s) => a + s.pct, 0);
    const remainder = 100 - agent;
    out = out.map((s) => (s.role === "agent" ? { ...s, pct: agent } : { ...s, pct: otherTotal > 0 ? Math.round(((s.pct / otherTotal) * remainder) * 1000) / 1000 : s.pct }));
    if (!out.some((s) => s.role === "agent")) out.unshift({ role: "agent", pct: agent });
    if (otherTotal === 0 && remainder > 0) out.push({ role: "company", pct: remainder });
    // Absorb rounding dust into the company/brokerage line (or the agent) so the percentages add to exactly 100.
    const dust = Math.round((100 - out.reduce((a, s) => a + s.pct, 0)) * 1000) / 1000;
    if (dust !== 0) { const target = out.find((s) => s.role !== "agent") ?? out[0]!; target.pct = Math.round((target.pct + dust) * 1000) / 1000; }
    out = out.filter((s) => s.pct > 0);
  }
  return { ratePct, splits: out, slab };
}

export const COMMISSION_SCOPE: ScopeColumns = {
  owner: "agentUserId",
  branch: "branchId",
  // A person who only appears as a split recipient (e.g. an introducer user) can still see their own commission.
  alsoOwnedVia: (ctx) => `id IN (SELECT calculation_id FROM commission_splits WHERE tenant_id = '${ctx.tenantId.replace(/[^a-f0-9-]/gi, "")}' AND user_id = '${ctx.userId.replace(/[^a-f0-9-]/gi, "")}')`,
};

export async function createCommissionPlan(sq: Sequelize, ctx: RequestContext, i: { name: string; dealType: "sale" | "lease"; ratePct: number; splits: CommissionSplitInput[]; agentType?: "any" | "internal" | "external"; vatPct?: number; slabs?: CommissionSlab[] }) {
  const slabs = validateSlabs(i.slabs);
  authorize(ctx, "commission.plan.manage");
  if (!(i.ratePct > 0 && i.ratePct <= 100)) throw new ConflictError("Rate must be between 0 and 100 percent");
  if (!i.splits.length || Math.abs(i.splits.reduce((a, s) => a + s.pct, 0) - 100) > 1e-9) throw new ConflictError("Splits must add up to exactly 100 percent");
  if (i.splits.some((s) => !(s.pct > 0))) throw new ConflictError("Every split needs a positive percentage");
  return withUow(sq, ctx, async (u) => {
    const p = await u.repo("CommissionPlan").create({ id: randomUUID(), name: i.name, dealType: i.dealType, ratePct: i.ratePct, splits: i.splits, active: true, agentType: i.agentType ?? "any", vatPct: i.vatPct ?? 5, slabs: slabs.length ? slabs : null }, { transaction: u.tx });
    await u.audit({ action: "commission_plan.created", entityType: "commission_plan", entityId: (p as any).get("id"), after: i });
    return plain(p);
  });
}

/** Called when a deal closes. The newest active plan for the deal type applies; no plan means no commission (not an error). */
export async function calculateCommissionInUow(u: Uow, ctx: RequestContext, deal: any) {
  // Plan choice: the agent's pinned plan, else the newest active plan for this deal type that targets the agent's type (or "any").
  const profile: any = await getAgentProfileIn(u, deal.get("agentUserId"));
  const agentType: "internal" | "external" = profile?.get("agentType") ?? "internal";
  let plan: any = profile?.get("commissionPlanId") ? await u.repo("CommissionPlan").findOne({ where: { id: profile.get("commissionPlanId"), active: true }, transaction: u.tx }) : null;
  if (!plan) {
    const plans = await u.repo("CommissionPlan").findAll({ where: { dealType: deal.get("dealType"), active: true, agentType: { [Op.in]: [agentType, "any"] } }, order: [["createdAt", "DESC"]], transaction: u.tx });
    // A plan written for this agent type beats a generic one.
    plan = (plans as any[]).find((p) => p.get("agentType") === agentType) ?? plans[0];
  }
  if (!plan) return null;
  const gross = toMinor(deal.get("amount"));
  const planSplits = (typeof plan.get("splits") === "string" ? JSON.parse(plan.get("splits")) : plan.get("splits")) as CommissionSplitInput[];
  const planSlabs = (typeof plan.get("slabs") === "string" ? JSON.parse(plan.get("slabs")) : plan.get("slabs")) as CommissionSlab[] | null;
  let ytd = 0;
  if (planSlabs?.length && deal.get("agentUserId")) {
    const year = new Date(Date.now() + 4 * 3_600_000).getUTCFullYear();
    const [row] = await u.sq.query<{ v: string | null }>(
      "SELECT COALESCE(SUM(gross_amount),0) AS v FROM commission_calculations WHERE tenant_id=:t AND agent_user_id=:a AND status <> 'void' AND calculated_at >= :s AND calculated_at < :e",
      { replacements: { t: ctx.tenantId, a: deal.get("agentUserId"), s: mysqlDate(new Date(`${year}-01-01T00:00:00+04:00`)), e: mysqlDate(new Date(`${year + 1}-01-01T00:00:00+04:00`)) }, transaction: u.tx, type: QueryTypes.SELECT },
    );
    ytd = Number(row?.v ?? 0);
  }
  const applied = applySlab(Number(plan.get("ratePct")), planSplits, planSlabs ?? [], ytd);
  const commission = Math.round((gross * applied.ratePct) / 100);
  const vat = Math.round((commission * Number(plan.get("vatPct") ?? 5)) / 100);
  const splits = applied.splits;
  const parts = allocateByPct(commission, splits.map((s) => s.pct));
  const id = randomUUID();
  await u.repo("CommissionCalculation").create({
    id, dealId: deal.get("id"), planId: plan.get("id"), agentUserId: deal.get("agentUserId"), branchId: deal.get("branchId"),
    grossAmount: fromMinor(gross), commissionAmount: fromMinor(commission), vatAmount: fromMinor(vat), agentType, currency: deal.get("currency"), status: "calculated", calculatedAt: mysqlDate(new Date()),
    slabApplied: applied.slab ? { ...applied.slab, ytdBefore: ytd, ratePct: applied.ratePct } : null,
  }, { transaction: u.tx });
  for (const [idx, s] of splits.entries()) {
    await u.repo("CommissionSplit").create({
      id: randomUUID(), calculationId: id, role: s.role, userId: s.role === "agent" ? deal.get("agentUserId") : null, pct: s.pct, amount: fromMinor(parts[idx]!),
    }, { transaction: u.tx });
  }
  await u.emit({ type: "commission.calculated", aggregateType: "deal", aggregateId: deal.get("id"), projectId: deal.get("projectId"), payload: { calculationId: id, amount: fromMinor(commission) } });
  return id;
}

/** Approval releases a commission for payout; it needs the approve permission and a fresh second factor. */
export async function approveCommission(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "commission.approve");
  requireStepUp(ctx);
  return withUow(sq, ctx, async (u) => {
    const c: any = await u.repo("CommissionCalculation").findById(id, { transaction: u.tx });
    if (!c) throw new NotFoundError("Commission");
    if (c.get("status") !== "calculated") throw new ConflictError(`A ${c.get("status")} commission cannot be approved`);
    await u.repo("CommissionCalculation").updateById(id, { status: "approved", approvedBy: ctx.userId, approvedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "commission.approved", entityType: "commission", entityId: id, after: { amount: c.get("commissionAmount"), dealId: c.get("dealId") } });
    await u.emit({ type: "commission.approved", aggregateType: "deal", aggregateId: c.get("dealId"), payload: { calculationId: id } });
    return plain(await u.repo("CommissionCalculation").findById(id, { transaction: u.tx }));
  });
}

/** Records the payout of an approved commission (bank transfer reference). Needs commission.approve and a fresh second factor. */
export async function markCommissionPaid(sq: Sequelize, ctx: RequestContext, id: string, reference: string) {
  authorize(ctx, "commission.approve");
  requireStepUp(ctx);
  if (!reference.trim()) throw new ConflictError("A payment reference is required");
  return withUow(sq, ctx, async (u) => {
    const c: any = await u.repo("CommissionCalculation").findById(id, { transaction: u.tx });
    if (!c) throw new NotFoundError("Commission");
    if (c.get("status") !== "approved") throw new ConflictError("Only an approved commission can be paid");
    if (c.get("paidAt")) throw new ConflictError("This commission is already paid");
    await u.repo("CommissionCalculation").updateById(id, { paidAt: new Date(), paidBy: ctx.userId, paidReference: reference.trim() }, { transaction: u.tx });
    await u.audit({ action: "commission.paid", entityType: "commission", entityId: id, after: { reference: reference.trim(), amount: c.get("commissionAmount") } });
    await u.emit({ type: "commission.paid", aggregateType: "deal", aggregateId: c.get("dealId"), payload: { calculationId: id } });
    return plain(await u.repo("CommissionCalculation").findById(id, { transaction: u.tx }));
  });
}

export async function listCommissions(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string }) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "commission.read", COMMISSION_SCOPE)];
    if (f.status) and.push({ status: f.status });
    const calcs = await u.repo("CommissionCalculation").findAll({ where: { [Op.and]: and }, order: [["calculatedAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx });
    const ids = (calcs as any[]).map((c) => c.get("id"));
    const splits = ids.length ? await u.repo("CommissionSplit").findAll({ where: { calculationId: { [Op.in]: ids } }, transaction: u.tx }) : [];
    return (calcs as any[]).map((c) => ({ ...plain(c), splits: (splits as any[]).filter((s) => s.get("calculationId") === c.get("id")).map(plain) }));
  });
}

export async function listCommissionPlans(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "commission.plan.manage");
  return withUow(sq, ctx, async (u) => (await u.repo("CommissionPlan").findAll({ order: [["createdAt", "DESC"]], transaction: u.tx })).map(plain));
}
