import { Op, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { ForbiddenError, hasPermission } from "@reales/rbac";
import { getSetting } from "./config";
import { assignLead, LEAD_SCOPE } from "./leads";
import { scopeWhere } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

export interface TransferInput { fromUserId: string; toUserId: string; scope: "open" | "hot" | "all"; reason?: string; dryRun?: boolean }

/**
 * Hand one person's leads to another, for example when an agent leaves or goes on leave. Every lead goes through the normal reassignment rules (the caller
 * must be allowed to assign it, the new owner is notified, history and audit are written), failures are listed per lead and never stop the rest.
 * With dryRun it only counts what would move.
 */
export async function transferLeads(sq: Sequelize, ctx: RequestContext, i: TransferInput) {
  if (!hasPermission(ctx, "lead.assign")) throw new ForbiddenError("Missing permission: lead.assign");
  if (i.fromUserId === i.toUserId) throw new ConflictError("Choose two different people");
  const needReason = await getSetting<boolean>(sq, ctx.tenantId, "leads.transfer_requires_reason");
  if (!i.dryRun && needReason && !i.reason?.trim()) throw new ConflictError("Say why these leads are being transferred");
  const ids = await withUow(sq, ctx, async (u) => {
    if (!(await u.repo("User").findOne({ where: { id: i.toUserId, status: "active" }, transaction: u.tx }))) throw new NotFoundError("New owner");
    if (!(await u.repo("User").findById(i.fromUserId, { transaction: u.tx }))) throw new NotFoundError("Current owner");
    const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
    const where: any[] = [scope, { assignedUserId: i.fromUserId }];
    if (i.scope !== "all") where.push({ status: "open" });
    if (i.scope === "hot") where.push({ isHot: true });
    return ((await u.repo("Lead").findAll({ where: { [Op.and]: where }, attributes: ["id"], limit: 1000, transaction: u.tx })) as any[]).map((l) => l.get("id") as string);
  });
  if (i.dryRun) return { count: ids.length, done: 0, failed: [] as { id: string; reason: string }[] };
  const out = { count: ids.length, done: 0, failed: [] as { id: string; reason: string }[] };
  const reason = `Transfer: ${i.reason?.trim() || "no reason given"}`;
  for (const id of ids) {
    try { await assignLead(sq, ctx, id, { userId: i.toUserId, reason }); out.done++; }
    catch (e) { out.failed.push({ id, reason: e instanceof Error ? e.message : "Failed" }); }
  }
  return out;
}
