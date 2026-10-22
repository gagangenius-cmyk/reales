import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { authorize, ForbiddenError, hasPermission } from "@reales/rbac";
import { LEAD_SCOPE } from "./leads";
import { notifyInUow } from "./notifications";
import { plain, scopeWhere } from "./scope";
import { routeLead } from "./routing";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

const DAY_MS = 86_400_000;
const mustHave = (ctx: RequestContext, p: string) => { if (!hasPermission(ctx, p)) throw new ForbiddenError(`Missing permission: ${p}`); };

// ------------------------------------------------------------------ pools
export interface PoolInput { id?: string; name: string; description?: string | null; branchId?: string | null; dailyClaimLimit?: number | null; active?: boolean }

export async function savePool(sq: Sequelize, ctx: RequestContext, i: PoolInput) {
  authorize(ctx, "pool.manage");
  if (!i.name.trim()) throw new ConflictError("A pool needs a name");
  if (i.dailyClaimLimit != null && !(i.dailyClaimLimit >= 1)) throw new ConflictError("The daily claim limit must be at least 1 (or empty for no limit)");
  return withUow(sq, ctx, async (u) => {
    if (i.branchId && !(await u.repo("Branch").findById(i.branchId, { transaction: u.tx }))) throw new NotFoundError("Branch");
    const values = { name: i.name.trim(), description: i.description?.trim() || null, branchId: i.branchId ?? null, dailyClaimLimit: i.dailyClaimLimit ?? null, active: i.active ?? true };
    let id = i.id;
    if (id) { if (!(await u.repo("LeadPool").findById(id, { transaction: u.tx }))) throw new NotFoundError("Pool"); await u.repo("LeadPool").updateById(id, values, { transaction: u.tx }); }
    else { id = randomUUID(); await u.repo("LeadPool").create({ id, ...values }, { transaction: u.tx }); }
    await u.audit({ action: i.id ? "lead_pool.updated" : "lead_pool.created", entityType: "lead_pool", entityId: id, after: values });
    return plain(await u.repo("LeadPool").findById(id, { transaction: u.tx }));
  });
}

/** Pools with how many open leads are waiting in each. Anyone who can claim or manage can see the pools. */
export async function listPools(sq: Sequelize, ctx: RequestContext) {
  if (!hasPermission(ctx, "pool.claim") && !hasPermission(ctx, "pool.manage")) throw new ForbiddenError("Missing permission: pool.claim");
  return withUow(sq, ctx, async (u) => {
    const pools = (await u.repo("LeadPool").findAll({ order: [["name", "ASC"]], transaction: u.tx })) as any[];
    const counts = await u.sq.query<{ pool_id: string; n: number }>("SELECT pool_id, COUNT(*) AS n FROM leads WHERE tenant_id=:t AND deleted_at IS NULL AND status='open' AND assigned_user_id IS NULL AND pool_id IS NOT NULL GROUP BY pool_id", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    const n = new Map(counts.map((c) => [c.pool_id, Number(c.n)]));
    return pools.map((p) => ({ ...plain(p), waiting: n.get(p.get("id")) ?? 0 }));
  });
}

/** Unassigned open leads in a pool, oldest first. Contact details are shown without the phone number until a lead is claimed. */
export async function poolLeads(sq: Sequelize, ctx: RequestContext, poolId: string, limit = 100) {
  if (!hasPermission(ctx, "pool.claim") && !hasPermission(ctx, "pool.manage")) throw new ForbiddenError("Missing permission: pool.claim");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("LeadPool").findById(poolId, { transaction: u.tx }))) throw new NotFoundError("Pool");
    const leads = (await u.repo("Lead").findAll({ where: { poolId, status: "open", assignedUserId: null }, order: [["pooledAt", "ASC"]], limit: Math.min(limit, 200), transaction: u.tx })) as any[];
    const contacts = leads.length ? ((await u.repo("Contact").findAll({ where: { id: { [Op.in]: leads.map((l) => l.get("contactId")) } }, transaction: u.tx })) as any[]) : [];
    const byId = new Map(contacts.map((c) => [c.get("id"), c]));
    return leads.map((l) => {
      const c = byId.get(l.get("contactId"));
      return { ...plain(l), contactName: c ? [c.get("firstName"), c.get("lastName")].filter(Boolean).join(" ") || c.get("companyName") || "Contact" : "Contact", nationality: c?.get("nationality") ?? null, language: c?.get("language") ?? null };
    });
  });
}

const dubaiDayStart = () => { const n = Date.now() + 4 * 3_600_000; return new Date(n - (n % DAY_MS) - 4 * 3_600_000); };

/** Take a lead from a pool. Atomic: two agents clicking at once cannot both get it. Respects the pool's daily claim limit. */
export async function claimLead(sq: Sequelize, ctx: RequestContext, leadId: string) {
  mustHave(ctx, "pool.claim");
  return withUow(sq, ctx, async (u) => {
    await u.sq.query("SELECT id FROM leads WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: leadId, t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    const lead: any = await u.repo("Lead").findById(leadId, { transaction: u.tx });
    if (!lead) throw new NotFoundError("Lead");
    if (lead.get("status") !== "open") throw new ConflictError("This lead is already closed");
    if (lead.get("assignedUserId") || !lead.get("poolId")) throw new ConflictError("Someone else already took this lead");
    const pool: any = await u.repo("LeadPool").findById(lead.get("poolId"), { transaction: u.tx });
    if (pool?.get("dailyClaimLimit") != null) {
      const [row] = await u.sq.query<{ n: number }>("SELECT COUNT(*) AS n FROM lead_assignments WHERE tenant_id=:t AND assigned_user_id=:u AND method='manual' AND reason LIKE 'Claimed from pool%' AND created_at >= :s", { replacements: { t: ctx.tenantId, u: ctx.userId, s: mysqlDate(dubaiDayStart()) }, transaction: u.tx, type: QueryTypes.SELECT });
      if (Number(row?.n ?? 0) >= Number(pool.get("dailyClaimLimit"))) throw new ConflictError(`You have reached today's limit of ${pool.get("dailyClaimLimit")} claimed leads for this pool`);
    }
    const me: any = await u.repo("User").findById(ctx.userId, { transaction: u.tx });
    await u.repo("Lead").updateById(leadId, { assignedUserId: ctx.userId, branchId: me?.get("branchId") ?? lead.get("branchId"), poolId: null, pooledAt: null }, { transaction: u.tx });
    await u.repo("LeadAssignment").create({ id: randomUUID(), leadId, assignedUserId: ctx.userId, previousUserId: null, ruleId: null, method: "manual", reason: `Claimed from pool ${pool?.get("name") ?? ""}`.trim(), actorId: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.audit({ action: "lead.claimed", entityType: "lead", entityId: leadId, after: { userId: ctx.userId, pool: pool?.get("name") } });
    await u.emit({ type: "lead.assigned", aggregateType: "lead", aggregateId: leadId, projectId: lead.get("projectId"), payload: { userId: ctx.userId, method: "pool_claim" } });
    return plain(await u.repo("Lead").findById(leadId, { transaction: u.tx }));
  });
}

/** Hand a lead back to a pool. The owner can do it for their own lead; managers (lead.assign) for any lead they can see. */
export async function releaseToPool(sq: Sequelize, ctx: RequestContext, leadId: string, poolId: string, reason: string) {
  if (!reason.trim()) throw new ConflictError("A reason is required to release a lead");
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
    const lead: any = await u.repo("Lead").findOne({ where: { [Op.and]: [{ id: leadId }, scope] }, transaction: u.tx });
    if (!lead) throw new NotFoundError("Lead");
    if (lead.get("status") !== "open") throw new ConflictError("Only open leads can go back to a pool");
    const mine = lead.get("assignedUserId") === ctx.userId;
    if (!mine && !hasPermission(ctx, "lead.assign")) throw new ForbiddenError("Only the owner or a manager can release this lead");
    const pool: any = await u.repo("LeadPool").findOne({ where: { id: poolId, active: true }, transaction: u.tx });
    if (!pool) throw new NotFoundError("Pool");
    await u.repo("Lead").updateById(leadId, { assignedUserId: null, poolId, pooledAt: new Date() }, { transaction: u.tx });
    await u.repo("LeadAssignment").create({ id: randomUUID(), leadId, assignedUserId: null, previousUserId: lead.get("assignedUserId"), ruleId: null, method: "manual", reason: `Released to pool ${pool.get("name")}: ${reason.trim()}`.slice(0, 255), actorId: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.audit({ action: "lead.released_to_pool", entityType: "lead", entityId: leadId, reason, after: { pool: pool.get("name") } });
    await u.emit({ type: "lead.assigned", aggregateType: "lead", aggregateId: leadId, projectId: lead.get("projectId"), payload: { userId: null, previous: lead.get("assignedUserId"), method: "pool_release" } });
    return plain(await u.repo("Lead").findById(leadId, { transaction: u.tx }));
  });
}

// ------------------------------------------------------------------ repool rules
export interface RepoolRuleInput { id?: string; name: string; triggerKind: "no_first_response" | "no_activity"; afterMinutes: number; action: "reassign" | "to_pool" | "notify_manager"; poolId?: string | null; maxRepools?: number; hotOnly?: boolean; active?: boolean }

export async function saveRepoolRule(sq: Sequelize, ctx: RequestContext, i: RepoolRuleInput) {
  authorize(ctx, "pool.manage");
  if (!i.name.trim()) throw new ConflictError("A rule needs a name");
  if (!(i.afterMinutes >= 5)) throw new ConflictError("Rules act after at least 5 minutes");
  if ((i.maxRepools ?? 3) < 1 || (i.maxRepools ?? 3) > 20) throw new ConflictError("Maximum repools must be between 1 and 20");
  return withUow(sq, ctx, async (u) => {
    if (i.action === "to_pool" && !i.poolId) throw new ConflictError("Choose the pool to send leads to");
    if (i.poolId && !(await u.repo("LeadPool").findById(i.poolId, { transaction: u.tx }))) throw new NotFoundError("Pool");
    const values = { name: i.name.trim(), triggerKind: i.triggerKind, afterMinutes: i.afterMinutes, action: i.action, poolId: i.poolId ?? null, maxRepools: i.maxRepools ?? 3, hotOnly: i.hotOnly ?? false, active: i.active ?? true };
    let id = i.id;
    if (id) { if (!(await u.repo("RepoolRule").findById(id, { transaction: u.tx }))) throw new NotFoundError("Rule"); await u.repo("RepoolRule").updateById(id, values, { transaction: u.tx }); }
    else { id = randomUUID(); await u.repo("RepoolRule").create({ id, ...values }, { transaction: u.tx }); }
    await u.audit({ action: i.id ? "repool_rule.updated" : "repool_rule.created", entityType: "repool_rule", entityId: id, after: values });
    return plain(await u.repo("RepoolRule").findById(id, { transaction: u.tx }));
  });
}

export async function listRepoolRules(sq: Sequelize, ctx: RequestContext) {
  mustHave(ctx, "pool.manage");
  return withUow(sq, ctx, async (u) => (await u.repo("RepoolRule").findAll({ order: [["afterMinutes", "ASC"]], transaction: u.tx })).map(plain));
}

export async function deleteRepoolRule(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "pool.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("RepoolRule").findById(id, { transaction: u.tx }))) throw new NotFoundError("Rule");
    await u.repo("RepoolRule").deleteById(id, { transaction: u.tx });
    await u.audit({ action: "repool_rule.deleted", entityType: "repool_rule", entityId: id });
  });
}

// ------------------------------------------------------------------ the sweep
export interface RepoolResult { reassigned: number; pooled: number; alerted: number }

/**
 * Applies every active rule to open, assigned leads whose clock has run out. The clock runs from the last time the lead was assigned (not from when it
 * was created), so a lead that has just been handed over is never snatched back. Idempotent: acting on a lead restarts its clock or takes it off the
 * agent, and manager alerts carry a dedupe key. `now` is injectable for tests.
 */
export async function repoolSweep(sq: Sequelize, ctx: RequestContext, now = new Date()): Promise<RepoolResult> {
  const out: RepoolResult = { reassigned: 0, pooled: 0, alerted: 0 };
  const rules = await withUow(sq, ctx, async (u) => (await u.repo("RepoolRule").findAll({ where: { active: true }, order: [["afterMinutes", "ASC"]], transaction: u.tx })) as any[]);
  for (const rule of rules) {
    const cutoff = new Date(now.getTime() - Number(rule.get("afterMinutes")) * 60_000);
    const due = await sq.query<{ id: string; assigned_user_id: string; since: Date }>(
      `SELECT l.id, l.assigned_user_id, COALESCE(a.at, l.created_at) AS since
         FROM leads l LEFT JOIN (SELECT lead_id, MAX(created_at) AS at FROM lead_assignments WHERE tenant_id=:t AND assigned_user_id IS NOT NULL GROUP BY lead_id) a ON a.lead_id = l.id
        WHERE l.tenant_id=:t AND l.deleted_at IS NULL AND l.status='open' AND l.assigned_user_id IS NOT NULL AND l.repool_count < :max
          AND (:hot = 0 OR l.is_hot = 1)
          AND ${rule.get("triggerKind") === "no_first_response" ? "l.first_response_at IS NULL AND COALESCE(a.at, l.created_at) <= :cutoff" : "GREATEST(COALESCE(l.last_contacted_at, '1970-01-01'), COALESCE(a.at, l.created_at)) <= :cutoff"}
        ORDER BY since ASC LIMIT 200`,
      { replacements: { t: ctx.tenantId, max: rule.get("maxRepools"), hot: rule.get("hotOnly") ? 1 : 0, cutoff: mysqlDate(cutoff) }, type: QueryTypes.SELECT },
    );
    for (const row of due) {
      try {
        await withUow(sq, ctx, async (u) => {
          await u.sq.query("SELECT id FROM leads WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: row.id, t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
          const lead: any = await u.repo("Lead").findById(row.id, { transaction: u.tx });
          if (!lead || lead.get("status") !== "open" || lead.get("assignedUserId") !== row.assigned_user_id) return; // changed under us
          const label = rule.get("name") as string;
          const history = (assignedUserId: string | null, ruleId: string | null, reason: string) =>
            u.repo("LeadAssignment").create({ id: randomUUID(), leadId: row.id, assignedUserId, previousUserId: row.assigned_user_id, ruleId, method: "rule", reason: reason.slice(0, 255), actorId: null, createdAt: mysqlDate(now) }, { transaction: u.tx });
          const toPool = async (poolId: string) => {
            await u.repo("Lead").updateById(row.id, { assignedUserId: null, poolId, pooledAt: now, repoolCount: Number(lead.get("repoolCount")) + 1 }, { transaction: u.tx });
            await history(null, rule.get("id"), `repool:${label}:to_pool`);
            await notifyInUow(u, { userId: row.assigned_user_id, kind: "lead.repooled", title: "A lead was taken back", body: `Rule "${label}": no ${rule.get("triggerKind") === "no_first_response" ? "first response" : "activity"} within ${rule.get("afterMinutes")} minutes.`, entityType: "lead", entityId: row.id, dedupeKey: `repool:${row.id}:${new Date(row.since).getTime()}` });
            await u.emit({ type: "lead.assigned", aggregateType: "lead", aggregateId: row.id, projectId: lead.get("projectId"), payload: { userId: null, previous: row.assigned_user_id, method: "repool" } });
            out.pooled++;
          };
          if (rule.get("action") === "notify_manager") {
            const me: any = await u.repo("User").findById(row.assigned_user_id, { transaction: u.tx });
            const mgrs = (await u.sq.query<{ user_id: string }>(
              "SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id=ur.role_id AND r.tenant_id=ur.tenant_id JOIN users u ON u.id=ur.user_id AND u.tenant_id=ur.tenant_id WHERE ur.tenant_id=:t AND r.`key` IN ('branch_manager','tenant_admin') AND u.status='active' AND (u.branch_id <=> :b OR r.`key`='tenant_admin')",
              { replacements: { t: ctx.tenantId, b: me?.get("branchId") ?? null }, transaction: u.tx, type: QueryTypes.SELECT })).map((m) => m.user_id);
            for (const m of mgrs) if (await notifyInUow(u, { userId: m, kind: "lead.stale", title: "A lead needs attention", body: `Rule "${label}": ${me?.get("email") ?? "an agent"} has not ${rule.get("triggerKind") === "no_first_response" ? "responded to" : "worked"} this lead.`, entityType: "lead", entityId: row.id, dedupeKey: `stale:${rule.get("id")}:${row.id}:${new Date(row.since).getTime()}` })) out.alerted++;
          } else if (rule.get("action") === "reassign") {
            const decision = await routeLead(u, ctx, { purpose: lead.get("purpose"), projectId: lead.get("projectId"), language: lead.get("language"), budgetMin: lead.get("budgetMin"), budgetMax: lead.get("budgetMax"), sourceKind: null, sourceCode: null });
            if (decision.userId && decision.userId !== row.assigned_user_id) {
              const next: any = await u.repo("User").findById(decision.userId, { transaction: u.tx });
              await u.repo("Lead").updateById(row.id, { assignedUserId: decision.userId, branchId: next?.get("branchId") ?? lead.get("branchId"), repoolCount: Number(lead.get("repoolCount")) + 1 }, { transaction: u.tx });
              await history(decision.userId, rule.get("id"), `repool:${label}:reassign`);
              await notifyInUow(u, { userId: decision.userId, kind: "lead.assigned", title: "A lead was assigned to you", body: `Reassigned by rule "${label}".`, entityType: "lead", entityId: row.id, dedupeKey: `repool-new:${row.id}:${now.getTime()}` });
              await notifyInUow(u, { userId: row.assigned_user_id, kind: "lead.repooled", title: "A lead was taken back", body: `Rule "${label}".`, entityType: "lead", entityId: row.id, dedupeKey: `repool:${row.id}:${new Date(row.since).getTime()}` });
              await u.emit({ type: "lead.assigned", aggregateType: "lead", aggregateId: row.id, projectId: lead.get("projectId"), payload: { userId: decision.userId, previous: row.assigned_user_id, method: "repool" } });
              out.reassigned++;
            } else if (rule.get("poolId")) await toPool(rule.get("poolId")); // nobody else is eligible: fall back to the pool when the rule names one
          } else if (rule.get("poolId")) await toPool(rule.get("poolId"));
        });
      } catch { /* one lead failing must not stop the sweep; it is retried on the next run */ }
    }
  }
  return out;
}
