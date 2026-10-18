import { assertAgentAvailable } from "./availability";
import { randomUUID } from "node:crypto";
import { Op, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { LEAD_SCOPE } from "./leads";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const VIEWING_SCOPE: ScopeColumns = { owner: "agentUserId", branch: "branchId", project: "projectId" };
const ref = (v: any) => ({ ownerUserId: v.get("agentUserId"), branchId: v.get("branchId"), projectId: v.get("projectId") });
const OPEN = ["scheduled", "checked_in"];

export interface ScheduleViewingInput {
  leadId?: string; contactId?: string; unitId?: string; listingId?: string; agentUserId?: string;
  scheduledAt: string | Date; durationMin?: number; locationNote?: string;
}

async function scopedViewing(u: Uow, ctx: RequestContext, id: string) {
  const scope = await scopeWhere(u, ctx, "viewing.read", VIEWING_SCOPE);
  const v: any = await u.repo("Viewing").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!v) throw new NotFoundError("Viewing");
  return v;
}

/**
 * Book a viewing. The agent's row is locked while checking for overlaps so two simultaneous bookings for the same agent
 * cannot both succeed (a double-booked agent is a real customer-facing failure).
 */
export async function scheduleViewing(sq: Sequelize, ctx: RequestContext, input: ScheduleViewingInput) {
  return withUow(sq, ctx, async (u) => {
    let lead: any = null;
    if (input.leadId) {
      const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
      lead = await u.repo("Lead").findOne({ where: { [Op.and]: [{ id: input.leadId }, scope] }, transaction: u.tx });
      if (!lead) throw new NotFoundError("Lead");
    }
    const contactId = input.contactId ?? lead?.get("contactId");
    if (!contactId) throw new ConflictError("A viewing needs a contact or a lead");
    if (!(await u.repo("Contact").findById(contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    const agentId = input.agentUserId ?? lead?.get("assignedUserId") ?? ctx.userId;
    const agent: any = await u.repo("User").findOne({ where: { id: agentId, status: "active" }, transaction: u.tx });
    if (!agent) throw new NotFoundError("Agent");

    let unit: any = null;
    let listing: any = null;
    if (input.listingId) {
      listing = await u.repo("Listing").findById(input.listingId, { transaction: u.tx });
      if (!listing) throw new NotFoundError("Listing");
    }
    const unitId = input.unitId ?? listing?.get("unitId") ?? null;
    if (unitId) {
      unit = await u.repo("Unit").findById(unitId, { transaction: u.tx });
      if (!unit) throw new NotFoundError("Unit");
      if (unit.get("status") !== "available") throw new ConflictError(`Unit is ${unit.get("status")}: it cannot be viewed`);
    }
    const branchId = lead?.get("branchId") ?? agent.get("branchId") ?? null;
    const projectId = lead?.get("projectId") ?? listing?.get("projectId") ?? null;
    authorize(ctx, "viewing.manage", { ownerUserId: agentId, branchId, projectId });

    const start = new Date(input.scheduledAt);
    if (Number.isNaN(start.getTime())) throw new ConflictError("Invalid viewing time");
    if (start.getTime() < Date.now() - 60_000) throw new ConflictError("A viewing cannot be scheduled in the past");
    const duration = input.durationMin ?? 30;
    const end = new Date(start.getTime() + duration * 60_000);

    await assertAgentAvailable(u, agentId, start, end);
    await u.sq.query("SELECT id FROM users WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: agentId, t: ctx.tenantId }, transaction: u.tx });
    const nearby = await u.repo("Viewing").findAll({
      where: { agentUserId: agentId, status: { [Op.in]: OPEN }, scheduledAt: { [Op.between]: [new Date(start.getTime() - 8 * 3_600_000), end] } }, transaction: u.tx,
    });
    const clash = (nearby as any[]).find((v) => {
      const s = new Date(v.get("scheduledAt")).getTime();
      const e = s + v.get("durationMin") * 60_000;
      return s < end.getTime() && start.getTime() < e;
    });
    if (clash) throw new ConflictError("The agent already has a viewing at that time");

    const id = randomUUID();
    const v = await u.repo("Viewing").create({
      id, leadId: input.leadId ?? null, contactId, unitId, listingId: input.listingId ?? null, agentUserId: agentId, branchId, projectId,
      scheduledAt: start, durationMin: duration, status: "scheduled", locationNote: input.locationNote ?? null, createdBy: ctx.userId,
    }, { transaction: u.tx });
    if (input.leadId) {
      const now = mysqlDate(new Date());
      await u.repo("Activity").create({ id: randomUUID(), entityType: "lead", entityId: input.leadId, kind: "viewing", summary: `Viewing booked for ${start.toISOString().slice(0, 16).replace("T", " ")} UTC`, actorId: ctx.userId, occurredAt: now, createdAt: now }, { transaction: u.tx });
    }
    await u.emit({ type: "viewing.booked", aggregateType: "viewing", aggregateId: id, projectId, payload: { agentUserId: agentId, scheduledAt: start.toISOString(), unitId } });
    return plain(v);
  });
}

async function transition(sq: Sequelize, ctx: RequestContext, id: string, from: string[], to: string, patch: Record<string, unknown>, eventType: string) {
  return withUow(sq, ctx, async (u) => {
    const v = await scopedViewing(u, ctx, id);
    authorize(ctx, "viewing.manage", ref(v));
    if (!from.includes(v.get("status"))) throw new ConflictError(`A ${v.get("status")} viewing cannot become ${to}`);
    await u.repo("Viewing").updateById(id, { status: to, ...patch }, { transaction: u.tx });
    await u.emit({ type: eventType, aggregateType: "viewing", aggregateId: id, projectId: v.get("projectId"), payload: { to } });
    return plain(await u.repo("Viewing").findById(id, { transaction: u.tx }));
  });
}

export const checkInViewing = (sq: Sequelize, ctx: RequestContext, id: string) => transition(sq, ctx, id, ["scheduled"], "checked_in", { checkedInAt: new Date() }, "viewing.checked_in");
export const markViewingNoShow = (sq: Sequelize, ctx: RequestContext, id: string) => transition(sq, ctx, id, ["scheduled"], "no_show", {}, "viewing.no_show");
export async function cancelViewing(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  if (!reason?.trim()) throw new ConflictError("A cancellation reason is required");
  return transition(sq, ctx, id, ["scheduled", "checked_in"], "cancelled", { cancelledReason: reason.trim() }, "viewing.cancelled");
}

export async function completeViewing(sq: Sequelize, ctx: RequestContext, id: string, feedback: { rating: number; interest: "high" | "medium" | "low" | "none"; notes?: string }) {
  if (!Number.isInteger(feedback.rating) || feedback.rating < 1 || feedback.rating > 5) throw new ConflictError("Rating must be a whole number from 1 to 5");
  return withUow(sq, ctx, async (u) => {
    const v = await scopedViewing(u, ctx, id);
    authorize(ctx, "viewing.manage", ref(v));
    if (!["scheduled", "checked_in"].includes(v.get("status"))) throw new ConflictError(`A ${v.get("status")} viewing cannot be completed`);
    await u.repo("Viewing").updateById(id, { status: "completed", completedAt: new Date() }, { transaction: u.tx });
    await u.repo("ViewingFeedback").create({ id: randomUUID(), viewingId: id, rating: feedback.rating, interest: feedback.interest, notes: feedback.notes ?? null, createdBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.emit({ type: "viewing.completed", aggregateType: "viewing", aggregateId: id, projectId: v.get("projectId"), payload: { interest: feedback.interest, rating: feedback.rating, leadId: v.get("leadId") } });
    return plain(await u.repo("Viewing").findById(id, { transaction: u.tx }));
  });
}

export async function listViewings(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string; from?: string; to?: string; mine?: boolean }) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "viewing.read", VIEWING_SCOPE)];
    if (f.status) and.push({ status: f.status });
    if (f.mine) and.push({ agentUserId: ctx.userId });
    if (f.from) and.push({ scheduledAt: { [Op.gte]: new Date(f.from) } });
    if (f.to) and.push({ scheduledAt: { [Op.lt]: new Date(f.to) } });
    return (await u.repo("Viewing").findAll({ where: { [Op.and]: and }, order: [["scheduledAt", "ASC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}
