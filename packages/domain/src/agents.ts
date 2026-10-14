import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize, hasPermission } from "@reales/rbac";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export type AgentType = "internal" | "external";
export interface AgentProfileInput {
  userId: string; agentType: AgentType; commissionPlanId?: string | null; brn?: string | null; agencyName?: string | null; agencyLicenceNo?: string | null;
  payoutNote?: string | null; status?: "active" | "inactive";
}

/** Create or replace the commercial profile of a user (internal staff or external/co-broke agent). Needs commission.plan.manage. */
export async function upsertAgentProfile(sq: Sequelize, ctx: RequestContext, i: AgentProfileInput) {
  authorize(ctx, "commission.plan.manage");
  if (i.agentType === "external" && !i.agencyName?.trim()) throw new ConflictError("An external agent needs the agency name (or 'Freelance')");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("User").findById(i.userId, { transaction: u.tx }))) throw new NotFoundError("User");
    if (i.commissionPlanId) {
      const plan: any = await u.repo("CommissionPlan").findById(i.commissionPlanId, { transaction: u.tx });
      if (!plan) throw new NotFoundError("Commission plan");
      const pt = plan.get("agentType");
      if (pt !== "any" && pt !== i.agentType) throw new ConflictError(`That plan is for ${pt} agents`);
    }
    const values = {
      agentType: i.agentType, commissionPlanId: i.commissionPlanId ?? null, brn: i.brn?.trim() || null,
      agencyName: i.agentType === "external" ? i.agencyName?.trim() || null : null, agencyLicenceNo: i.agencyLicenceNo?.trim() || null,
      payoutNote: i.payoutNote?.trim() || null, status: i.status ?? "active",
    };
    const existing: any = await u.repo("AgentProfile").findOne({ where: { userId: i.userId }, transaction: u.tx });
    let id: string;
    if (existing) { id = existing.get("id"); await u.repo("AgentProfile").updateById(id, values, { transaction: u.tx }); }
    else { id = randomUUID(); await u.repo("AgentProfile").create({ id, userId: i.userId, ...values }, { transaction: u.tx }); }
    await u.audit({ action: existing ? "agent_profile.updated" : "agent_profile.created", entityType: "agent_profile", entityId: id, before: existing ? plain(existing) : undefined, after: values });
    return plain(await u.repo("AgentProfile").findById(id, { transaction: u.tx }));
  });
}

/** Everyone who can be paid commission: each active user with their profile (or the implicit internal default). Needs user or commission visibility. */
export async function listAgentDirectory(sq: Sequelize, ctx: RequestContext) {
  if (!hasPermission(ctx, "commission.plan.manage") && !hasPermission(ctx, "user.read")) authorize(ctx, "commission.plan.manage");
  return withUow(sq, ctx, async (u) => {
    const [users, profiles] = await Promise.all([
      u.repo("User").findAll({ where: { status: { [Op.in]: ["active", "invited"] } }, order: [["email", "ASC"]], transaction: u.tx }),
      u.repo("AgentProfile").findAll({ transaction: u.tx }),
    ]);
    const byUser = new Map((profiles as any[]).map((p) => [p.get("userId"), plain(p)]));
    return (users as any[]).map((x) => ({ userId: x.get("id"), email: x.get("email"), status: x.get("status"), profile: byUser.get(x.get("id")) ?? null }));
  });
}

export async function getAgentProfileIn(u: Uow, userId: string | null) {
  if (!userId) return null;
  return (await u.repo("AgentProfile").findOne({ where: { userId }, transaction: u.tx })) ?? null;
}
