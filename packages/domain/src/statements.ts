import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { fromMinor, toMinor } from "./money";
import { plain, scopeWhere } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";
import { PORTFOLIO_SCOPE } from "./leases";

const periodRange = (period: string) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ConflictError("Period must be YYYY-MM");
  const [y, m] = period.split("-").map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
};

/**
 * Owner statement for one portfolio and month: rent collected (allocations on payments received in the month, for leases of the portfolio)
 * minus the management fee (agreement percentage on that rent) minus completed maintenance cost. Recomputed while draft; frozen once issued.
 */
export async function generateOwnerStatement(sq: Sequelize, ctx: RequestContext, portfolioId: string, period: string) {
  authorize(ctx, "statement.generate");
  const { from, to } = periodRange(period);
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "statement.generate", PORTFOLIO_SCOPE);
    if (!(await u.repo("Portfolio").findOne({ where: { [Op.and]: [{ id: portfolioId }, scope] }, transaction: u.tx }))) throw new NotFoundError("Portfolio");
    const existing: any = await u.repo("OwnerStatement").findOne({ where: { portfolioId, period }, transaction: u.tx });
    if (existing?.get("status") === "issued") throw new ConflictError("This statement has been issued and cannot be regenerated");

    const rent = (await u.sq.query<any>(
      `SELECT COALESCE(SUM(ra.amount),0) AS total FROM rent_allocations ra
         JOIN payments p ON p.id = ra.payment_id AND p.tenant_id = ra.tenant_id
         JOIN rent_schedules rs ON rs.id = ra.rent_schedule_id AND rs.tenant_id = ra.tenant_id
         JOIN leases l ON l.id = rs.lease_id AND l.tenant_id = rs.tenant_id
        WHERE ra.tenant_id=:t AND l.portfolio_id=:p AND p.received_at >= :from AND p.received_at < :to`,
      { replacements: { t: ctx.tenantId, p: portfolioId, from, to }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    const maint = (await u.sq.query<any>(
      `SELECT COALESCE(SUM(w.final_cost),0) AS total FROM work_orders w JOIN maintenance_tickets k ON k.id = w.ticket_id AND k.tenant_id = w.tenant_id
        WHERE w.tenant_id=:t AND k.portfolio_id=:p AND w.status='completed' AND w.completed_at >= :from AND w.completed_at < :to`,
      { replacements: { t: ctx.tenantId, p: portfolioId, from, to }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    const agreement: any = await u.repo("ManagementAgreement").findOne({ where: { portfolioId, status: "active" }, transaction: u.tx });
    const feePct = agreement ? Number(agreement.get("feePct")) : 0;

    const rentMinor = toMinor(rent[0]?.total);
    const feeMinor = Math.round((rentMinor * feePct) / 100);
    const maintMinor = toMinor(maint[0]?.total);
    const values = {
      rentCollected: fromMinor(rentMinor), managementFee: fromMinor(feeMinor), maintenanceCost: fromMinor(maintMinor), netPayable: fromMinor(rentMinor - feeMinor - maintMinor),
      detail: { feePct, agreementId: agreement?.get("id") ?? null, from: from.toISOString(), to: to.toISOString() },
    };
    if (existing) await u.repo("OwnerStatement").updateById(existing.get("id"), values, { transaction: u.tx });
    else await u.repo("OwnerStatement").create({ id: randomUUID(), portfolioId, period, currency: "AED", status: "draft", ...values }, { transaction: u.tx });
    await u.audit({ action: "statement.generated", entityType: "portfolio", entityId: portfolioId, after: { period, netPayable: values.netPayable } });
    return plain(await u.repo("OwnerStatement").findOne({ where: { portfolioId, period }, transaction: u.tx }));
  });
}

export async function issueOwnerStatement(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "statement.generate");
  return withUow(sq, ctx, async (u) => {
    const s: any = await u.repo("OwnerStatement").findById(id, { transaction: u.tx });
    if (!s) throw new NotFoundError("Statement");
    if (s.get("status") !== "draft") throw new ConflictError("The statement is already issued");
    await u.repo("OwnerStatement").updateById(id, { status: "issued", issuedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "statement.issued", entityType: "owner_statement", entityId: id });
    await u.emit({ type: "statement.issued", aggregateType: "owner_statement", aggregateId: id, payload: { portfolioId: s.get("portfolioId"), period: s.get("period") } });
    return plain(await u.repo("OwnerStatement").findById(id, { transaction: u.tx }));
  });
}

export async function listOwnerStatements(sq: Sequelize, ctx: RequestContext, f: { portfolioId?: string; limit: number; offset: number }) {
  authorize(ctx, "statement.read");
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "statement.read", PORTFOLIO_SCOPE);
    const owned = (await u.repo("Portfolio").findAll({ where: scope, attributes: ["id"], transaction: u.tx })) as any[];
    const ids = owned.map((p) => p.get("id"));
    const where: any = { portfolioId: f.portfolioId ? (ids.includes(f.portfolioId) ? f.portfolioId : "00000000-0000-0000-0000-000000000000") : { [Op.in]: ids } };
    return (await u.repo("OwnerStatement").findAll({ where, order: [["period", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}

/** One statement, only if its portfolio is visible to the caller (same scope as the list). */
export async function getOwnerStatement(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "statement.read");
  return withUow(sq, ctx, async (u) => {
    const s: any = await u.repo("OwnerStatement").findById(id, { transaction: u.tx });
    if (!s) throw new NotFoundError("Statement");
    const scope = await scopeWhere(u, ctx, "statement.read", PORTFOLIO_SCOPE);
    const p: any = await u.repo("Portfolio").findOne({ where: { [Op.and]: [{ id: s.get("portfolioId") }, scope] }, transaction: u.tx });
    if (!p) throw new NotFoundError("Statement");
    return { ...plain(s), portfolioName: p.get("name") };
  });
}
