import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export interface RoutingConditions {
  sourceKinds?: string[]; sourceCodes?: string[]; projectIds?: string[]; languages?: string[]; purposes?: string[];
  minBudget?: number; maxBudget?: number;
}
export interface RoutingTarget { userIds?: string[]; teamId?: string; branchId?: string }
export interface RoutingRuleInput {
  name: string; priority?: number; active?: boolean; conditions: RoutingConditions; target: RoutingTarget;
  strategy?: "round_robin" | "least_loaded"; maxOpenLeads?: number | null;
}

export interface RoutableLead {
  purpose: string; projectId: string | null; language: string | null; budgetMax: number | null; budgetMin: number | null;
  sourceKind: string | null; sourceCode: string | null;
}

export interface RoutingDecision { userId: string | null; ruleId: string | null; method: "rule" | "fallback"; reason: string }

export function ruleMatches(c: RoutingConditions, l: RoutableLead): boolean {
  if (c.sourceKinds?.length && (!l.sourceKind || !c.sourceKinds.includes(l.sourceKind))) return false;
  if (c.sourceCodes?.length && (!l.sourceCode || !c.sourceCodes.includes(l.sourceCode))) return false;
  if (c.projectIds?.length && (!l.projectId || !c.projectIds.includes(l.projectId))) return false;
  if (c.languages?.length && (!l.language || !c.languages.includes(l.language))) return false;
  if (c.purposes?.length && !c.purposes.includes(l.purpose)) return false;
  const budget = l.budgetMax ?? l.budgetMin;
  if (c.minBudget !== undefined && (budget === null || budget < c.minBudget)) return false;
  if (c.maxBudget !== undefined && (budget === null || budget > c.maxBudget)) return false;
  return true;
}

const parseJson = <T,>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : (v as T));

async function candidateUsers(u: Uow, ctx: Pick<RequestContext, "tenantId">, t: RoutingTarget): Promise<string[]> {
  const ids = new Set<string>();
  t.userIds?.forEach((i) => ids.add(i));
  if (t.teamId) {
    const rows = await u.repo("TeamMember").findAll({ where: { teamId: t.teamId }, transaction: u.tx });
    rows.forEach((r: any) => ids.add(r.get("userId")));
  }
  if (t.branchId) {
    const rows = await u.repo("User").findAll({ where: { branchId: t.branchId }, transaction: u.tx });
    rows.forEach((r: any) => ids.add(r.get("id")));
  }
  if (!ids.size) return [];
  const active = await u.repo("User").findAll({ where: { id: { [Op.in]: [...ids] }, status: "active" }, transaction: u.tx });
  return active.map((r: any) => r.get("id")).sort();
}

/**
 * Pick the agent for a new lead: first matching active rule (by priority) with at least one eligible candidate wins.
 * Eligible = active user inside the rule target, below the rule capacity cap. Strategy decides among candidates.
 * The rule row is locked for the transaction so concurrent inbound leads cannot both pick the same "next" agent.
 */
export async function routeLead(u: Uow, ctx: Pick<RequestContext, "tenantId">, lead: RoutableLead): Promise<RoutingDecision> {
  const rules = await u.repo("RoutingRule").findAll({ where: { active: true }, order: [["priority", "ASC"], ["id", "ASC"]], transaction: u.tx });
  for (const r of rules as any[]) {
    const cond = parseJson<RoutingConditions>(r.get("conditions"));
    if (!ruleMatches(cond, lead)) continue;
    await u.sq.query("SELECT id FROM routing_rules WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: r.get("id"), t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    let candidates = await candidateUsers(u, ctx, parseJson<RoutingTarget>(r.get("target")));
    if (!candidates.length) continue;

    const open = await u.sq.query<{ uid: string; n: number }>(
      "SELECT assigned_user_id AS uid, COUNT(*) AS n FROM leads WHERE tenant_id=:t AND deleted_at IS NULL AND status='open' AND assigned_user_id IN (:ids) GROUP BY assigned_user_id",
      { replacements: { t: ctx.tenantId, ids: candidates }, transaction: u.tx, type: QueryTypes.SELECT },
    );
    const load = new Map(open.map((o) => [o.uid, Number(o.n)]));
    const cap = r.get("maxOpenLeads") as number | null;
    if (cap != null) candidates = candidates.filter((id) => (load.get(id) ?? 0) < cap);
    if (!candidates.length) continue;

    const last = await u.sq.query<{ uid: string; at: Date }>(
      "SELECT assigned_user_id AS uid, MAX(created_at) AS at FROM lead_assignments WHERE tenant_id=:t AND rule_id=:r AND assigned_user_id IN (:ids) GROUP BY assigned_user_id",
      { replacements: { t: ctx.tenantId, r: r.get("id"), ids: candidates }, transaction: u.tx, type: QueryTypes.SELECT },
    );
    const lastAt = new Map(last.map((l) => [l.uid, new Date(l.at).getTime()]));
    const byOldest = (a: string, b: string) => (lastAt.get(a) ?? -1) - (lastAt.get(b) ?? -1) || a.localeCompare(b);
    const pick = r.get("strategy") === "least_loaded"
      ? [...candidates].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || byOldest(a, b))[0]!
      : [...candidates].sort(byOldest)[0]!;
    return { userId: pick, ruleId: r.get("id"), method: "rule", reason: `rule:${r.get("name")}:${r.get("strategy")}` };
  }
  return { userId: null, ruleId: null, method: "fallback", reason: rules.length ? "no eligible agent in any matching rule" : "no routing rules configured" };
}

export async function createRoutingRule(sq: Sequelize, ctx: RequestContext, input: RoutingRuleInput) {
  authorize(ctx, "routing.manage");
  return withUow(sq, ctx, async (u) => {
    if (!input.target.userIds?.length && !input.target.teamId && !input.target.branchId) throw new ConflictError("Routing target needs users, a team or a branch");
    if (input.target.teamId && !(await u.repo("Team").findById(input.target.teamId, { transaction: u.tx }))) throw new NotFoundError("Team");
    if (input.target.branchId && !(await u.repo("Branch").findById(input.target.branchId, { transaction: u.tx }))) throw new NotFoundError("Branch");
    for (const uid of input.target.userIds ?? []) if (!(await u.repo("User").findById(uid, { transaction: u.tx }))) throw new NotFoundError("User");
    const id = randomUUID();
    const rule = await u.repo("RoutingRule").create({
      id, name: input.name, priority: input.priority ?? 100, active: input.active ?? true, conditions: input.conditions, target: input.target,
      strategy: input.strategy ?? "round_robin", maxOpenLeads: input.maxOpenLeads ?? null,
    }, { transaction: u.tx });
    await u.audit({ action: "routing_rule.created", entityType: "routing_rule", entityId: id, after: input });
    return plain(rule);
  });
}

export async function listRoutingRules(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "routing.manage");
  return withUow(sq, ctx, async (u) => (await u.repo("RoutingRule").findAll({ order: [["priority", "ASC"]], transaction: u.tx })).map(plain));
}
