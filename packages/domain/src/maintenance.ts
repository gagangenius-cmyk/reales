import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { fromMinor, toMinor } from "./money";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { assertSweepAllowed, ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const TICKET_SCOPE: ScopeColumns = { owner: "assignedUserId", branch: "branchId", portfolio: "portfolioId" };
export const SLA_HOURS = { urgent: 4, high: 24, normal: 72, low: 168 } as const;
export type Priority = keyof typeof SLA_HOURS;
const ref = (t: any) => ({ ownerUserId: t.get("assignedUserId"), branchId: t.get("branchId"), portfolioId: t.get("portfolioId") });

// ---------------------------------------------------------------- vendors
export async function createVendor(sq: Sequelize, ctx: RequestContext, i: { name: string; categories: string[]; contactName?: string; phoneE164?: string; email?: string; tradeLicenceNo?: string; licenceExpiresOn?: string }) {
  authorize(ctx, "vendor.manage");
  return withUow(sq, ctx, async (u) => {
    const v = await u.repo("Vendor").create({ id: randomUUID(), ...i, categories: i.categories, status: "active" }, { transaction: u.tx });
    await u.audit({ action: "vendor.created", entityType: "vendor", entityId: (v as any).get("id"), after: { name: i.name } });
    return plain(v);
  });
}
export async function listVendors(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "maintenance.read");
  return withUow(sq, ctx, async (u) => (await u.repo("Vendor").findAll({ order: [["name", "ASC"]], transaction: u.tx })).map(plain));
}
export async function setVendorStatus(sq: Sequelize, ctx: RequestContext, id: string, status: "active" | "suspended") {
  authorize(ctx, "vendor.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Vendor").findById(id, { transaction: u.tx }))) throw new NotFoundError("Vendor");
    await u.repo("Vendor").updateById(id, { status }, { transaction: u.tx });
    await u.audit({ action: "vendor.status_changed", entityType: "vendor", entityId: id, after: { status } });
    return plain(await u.repo("Vendor").findById(id, { transaction: u.tx }));
  });
}

// ---------------------------------------------------------------- tickets
async function scopedTicket(u: Uow, ctx: RequestContext, id: string) {
  const scope = await scopeWhere(u, ctx, "maintenance.read", TICKET_SCOPE);
  const t: any = await u.repo("Ticket").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!t) throw new NotFoundError("Ticket");
  return t;
}
async function event(u: Uow, ctx: RequestContext, ticketId: string, type: string, detail: unknown, workOrderId?: string) {
  await u.repo("WorkOrderEvent").create({ id: randomUUID(), ticketId, workOrderId: workOrderId ?? null, type, detail: detail ?? {}, actorId: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
}

export interface TicketInput { unitId: string; category: string; priority?: Priority; title: string; description?: string; reporterContactId?: string; assignedUserId?: string }

/** Shared by staff and the tenant portal. The CALLER decides who may create (permission or lease ownership); this only does the work. */
export async function createTicketInUow(u: Uow, ctx: RequestContext, i: TicketInput): Promise<string> {
  const unit: any = await u.repo("Unit").findById(i.unitId, { transaction: u.tx });
  if (!unit) throw new NotFoundError("Unit");
  if (i.reporterContactId && !(await u.repo("Contact").findById(i.reporterContactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
  if (i.assignedUserId && !(await u.repo("User").findOne({ where: { id: i.assignedUserId, status: "active" }, transaction: u.tx }))) throw new NotFoundError("Assignee");
  const owners = (await u.repo("Ownership").findAll({ where: { unitId: i.unitId, toDate: null }, transaction: u.tx })) as any[];
  const portfolioId = owners.length === 1 ? owners[0].get("portfolioId") : null;
  const portfolio: any = portfolioId ? await u.repo("Portfolio").findById(portfolioId, { transaction: u.tx }) : null;
  const today = new Date().toISOString().slice(0, 10);
  const lease: any = await u.repo("Lease").findOne({ where: { unitId: i.unitId, status: "active", startsOn: { [Op.lte]: today }, endsOn: { [Op.gte]: today } }, transaction: u.tx });
  const priority = i.priority ?? "normal";
  const now = new Date();
  const id = randomUUID();
  await u.repo("Ticket").create({
    id, unitId: i.unitId, leaseId: lease?.get("id") ?? null, portfolioId, branchId: portfolio?.get("branchId") ?? ctx.membership.branchIds[0] ?? null, reporterContactId: i.reporterContactId ?? null,
    assignedUserId: i.assignedUserId ?? null, category: i.category, priority, status: "new", title: i.title, description: i.description ?? null,
    slaDueAt: new Date(now.getTime() + SLA_HOURS[priority] * 3_600_000), createdBy: ctx.userId,
  }, { transaction: u.tx });
  await event(u, ctx, id, "created", { priority, slaHours: SLA_HOURS[priority] });
  await u.audit({ action: "ticket.created", entityType: "ticket", entityId: id, after: { unitId: i.unitId, priority } });
  await u.emit({ type: "ticket.created", aggregateType: "ticket", aggregateId: id, payload: { unitId: i.unitId, priority } });
  return id;
}

export async function createTicket(sq: Sequelize, ctx: RequestContext, i: TicketInput) {
  authorize(ctx, "maintenance.manage");
  return withUow(sq, ctx, async (u) => getTicketInUow(u, ctx, await createTicketInUow(u, ctx, i)));
}

async function getTicketInUow(u: Uow, ctx: RequestContext, id: string) {
  const t = await scopedTicket(u, ctx, id);
  const [quotes, orders, events] = await Promise.all([
    u.repo("Quotation").findAll({ where: { ticketId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
    u.repo("WorkOrder").findAll({ where: { ticketId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
    u.repo("WorkOrderEvent").findAll({ where: { ticketId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
  ]);
  return { ...plain(t), quotations: quotes.map(plain), workOrders: orders.map(plain), events: events.map(plain) };
}
export const getTicket = (sq: Sequelize, ctx: RequestContext, id: string) => withUow(sq, ctx, (u) => getTicketInUow(u, ctx, id));

export async function listTickets(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string; unitId?: string; breachedOnly?: boolean }) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "maintenance.read", TICKET_SCOPE)];
    if (f.status) and.push({ status: f.status });
    if (f.unitId) and.push({ unitId: f.unitId });
    if (f.breachedOnly) and.push({ slaBreachedAt: { [Op.ne]: null } });
    return (await u.repo("Ticket").findAll({ where: { [Op.and]: and }, order: [["slaDueAt", "ASC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}

const FLOW: Record<string, string[]> = {
  new: ["triaged", "cancelled"], triaged: ["quoted", "approved", "in_progress", "cancelled"], quoted: ["approved", "cancelled"],
  approved: ["in_progress", "cancelled"], in_progress: ["completed", "cancelled"], completed: ["closed", "in_progress"], closed: [], cancelled: [],
};

export async function triageTicket(sq: Sequelize, ctx: RequestContext, id: string, i: { assignedUserId?: string; priority?: Priority }) {
  return withUow(sq, ctx, async (u) => {
    const t = await scopedTicket(u, ctx, id);
    authorize(ctx, "maintenance.manage", ref(t));
    if (t.get("status") !== "new") throw new ConflictError("Only a new ticket can be triaged");
    if (i.assignedUserId && !(await u.repo("User").findOne({ where: { id: i.assignedUserId, status: "active" }, transaction: u.tx }))) throw new NotFoundError("Assignee");
    const patch: Record<string, unknown> = { status: "triaged" };
    if (i.assignedUserId) patch.assignedUserId = i.assignedUserId;
    if (i.priority && i.priority !== t.get("priority")) {
      patch.priority = i.priority;
      // The SLA clock started at creation; reprioritising restates the due time from that same start.
      patch.slaDueAt = new Date(new Date(t.get("createdAt")).getTime() + SLA_HOURS[i.priority] * 3_600_000);
    }
    await u.repo("Ticket").updateById(id, patch, { transaction: u.tx });
    await event(u, ctx, id, "triaged", { assignedUserId: i.assignedUserId, priority: i.priority });
    return getTicketInUow(u, ctx, id);
  });
}

async function moveTicket(u: Uow, ctx: RequestContext, t: any, to: string, extra: Record<string, unknown> = {}) {
  const from = t.get("status") as string;
  if (!FLOW[from]?.includes(to)) throw new ConflictError(`A ticket cannot move from ${from} to ${to}`);
  await u.repo("Ticket").updateById(t.get("id"), { status: to, ...extra }, { transaction: u.tx });
}

export async function cancelTicket(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  if (!reason?.trim()) throw new ConflictError("A reason is required");
  return withUow(sq, ctx, async (u) => {
    const t = await scopedTicket(u, ctx, id);
    authorize(ctx, "maintenance.manage", ref(t));
    await moveTicket(u, ctx, t, "cancelled");
    await event(u, ctx, id, "cancelled", { reason });
    await u.audit({ action: "ticket.cancelled", entityType: "ticket", entityId: id, reason });
    return getTicketInUow(u, ctx, id);
  });
}

// ---------------------------------------------------------------- quotations, approval, work orders
export async function submitQuotation(sq: Sequelize, ctx: RequestContext, ticketId: string, i: { vendorId: string; amount: number; notes?: string }) {
  return withUow(sq, ctx, async (u) => {
    const t = await scopedTicket(u, ctx, ticketId);
    authorize(ctx, "maintenance.manage", ref(t));
    if (!["triaged", "quoted"].includes(t.get("status"))) throw new ConflictError("Quotes can be added to a triaged ticket");
    if (!(i.amount > 0)) throw new ConflictError("Quote amount must be positive");
    const v: any = await u.repo("Vendor").findById(i.vendorId, { transaction: u.tx });
    if (!v) throw new NotFoundError("Vendor");
    if (v.get("status") !== "active") throw new ConflictError("The vendor is suspended");
    const q = await u.repo("Quotation").create({ id: randomUUID(), ticketId, vendorId: i.vendorId, amount: i.amount, currency: "AED", status: "submitted", notes: i.notes ?? null }, { transaction: u.tx });
    if (t.get("status") === "triaged") await moveTicket(u, ctx, t, "quoted");
    await event(u, ctx, ticketId, "quotation_submitted", { vendorId: i.vendorId, amount: i.amount });
    return plain(q);
  });
}

/** Tenant setting `maintenance.approval_threshold`: quotes above it need maintenance.approve; at or below, maintenance.manage is enough. */
async function approvalThreshold(u: Uow): Promise<number | null> {
  const s: any = await u.repo("TenantSetting").findOne({ where: { key: "maintenance.approval_threshold" }, transaction: u.tx });
  const v = s?.get("value");
  return v === null || v === undefined ? null : Number(v);
}

export async function decideQuotation(sq: Sequelize, ctx: RequestContext, ticketId: string, quotationId: string, outcome: "approved" | "rejected") {
  return withUow(sq, ctx, async (u) => {
    const t = await scopedTicket(u, ctx, ticketId);
    const q: any = await u.repo("Quotation").findOne({ where: { id: quotationId, ticketId }, transaction: u.tx });
    if (!q) throw new NotFoundError("Quotation");
    if (q.get("status") !== "submitted") throw new ConflictError(`The quotation is already ${q.get("status")}`);
    const threshold = await approvalThreshold(u);
    if (outcome === "approved") {
      authorize(ctx, threshold !== null && Number(q.get("amount")) <= threshold ? "maintenance.manage" : "maintenance.approve", ref(t));
    } else authorize(ctx, "maintenance.manage", ref(t));
    await u.repo("Quotation").updateById(quotationId, { status: outcome, decidedBy: ctx.userId, decidedAt: new Date() }, { transaction: u.tx });
    if (outcome === "approved") {
      await u.sq.query("UPDATE quotations SET status='rejected', decided_by=:by, decided_at=NOW(3) WHERE tenant_id=:t AND ticket_id=:k AND id<>:q AND status='submitted'", { replacements: { by: ctx.userId, t: ctx.tenantId, k: ticketId, q: quotationId }, transaction: u.tx });
      await moveTicket(u, ctx, t, "approved");
    }
    await event(u, ctx, ticketId, `quotation_${outcome}`, { quotationId, amount: q.get("amount") });
    await u.audit({ action: `quotation.${outcome}`, entityType: "ticket", entityId: ticketId, after: { quotationId, amount: q.get("amount") } });
    return getTicketInUow(u, ctx, ticketId);
  });
}

export async function issueWorkOrder(sq: Sequelize, ctx: RequestContext, ticketId: string, i: { vendorId?: string; scheduledAt?: string }) {
  return withUow(sq, ctx, async (u) => {
    const t = await scopedTicket(u, ctx, ticketId);
    authorize(ctx, "maintenance.manage", ref(t));
    if (await u.repo("WorkOrder").findOne({ where: { ticketId, status: { [Op.in]: ["issued", "in_progress"] } }, transaction: u.tx })) throw new ConflictError("The ticket already has an open work order");
    const approved: any = await u.repo("Quotation").findOne({ where: { ticketId, status: "approved" }, transaction: u.tx });
    let vendorId = approved?.get("vendorId") ?? i.vendorId;
    if (!vendorId) throw new ConflictError("A vendor is required (approve a quotation or name one)");
    const v: any = await u.repo("Vendor").findById(vendorId, { transaction: u.tx });
    if (!v) throw new NotFoundError("Vendor");
    if (v.get("status") !== "active") throw new ConflictError("The vendor is suspended");
    if (!approved && !["triaged", "quoted", "approved"].includes(t.get("status"))) throw new ConflictError("Ticket is not ready for a work order");
    const id = randomUUID();
    await u.repo("WorkOrder").create({ id, ticketId, vendorId, quotationId: approved?.get("id") ?? null, scheduledAt: i.scheduledAt ? new Date(i.scheduledAt) : null, status: "issued", quotedAmount: approved?.get("amount") ?? null, currency: "AED" }, { transaction: u.tx });
    if (t.get("status") !== "approved" && FLOW[t.get("status")]?.includes("approved")) await moveTicket(u, ctx, t, "approved");
    await event(u, ctx, ticketId, "work_order_issued", { vendorId }, id);
    await u.emit({ type: "work_order.issued", aggregateType: "ticket", aggregateId: ticketId, payload: { workOrderId: id, vendorId } });
    return getTicketInUow(u, ctx, ticketId);
  });
}

export async function startWork(sq: Sequelize, ctx: RequestContext, ticketId: string) {
  return withUow(sq, ctx, async (u) => {
    const t = await scopedTicket(u, ctx, ticketId);
    authorize(ctx, "maintenance.manage", ref(t));
    const wo: any = await u.repo("WorkOrder").findOne({ where: { ticketId, status: "issued" }, transaction: u.tx });
    if (!wo) throw new ConflictError("There is no issued work order to start");
    await u.repo("WorkOrder").updateById(wo.get("id"), { status: "in_progress" }, { transaction: u.tx });
    await moveTicket(u, ctx, t, "in_progress");
    await event(u, ctx, ticketId, "work_started", {}, wo.get("id"));
    return getTicketInUow(u, ctx, ticketId);
  });
}

export async function completeWork(sq: Sequelize, ctx: RequestContext, ticketId: string, i: { finalCost: number; notes?: string }) {
  if (!(i.finalCost >= 0)) throw new ConflictError("Final cost cannot be negative");
  return withUow(sq, ctx, async (u) => {
    const t = await scopedTicket(u, ctx, ticketId);
    authorize(ctx, "maintenance.manage", ref(t));
    const wo: any = await u.repo("WorkOrder").findOne({ where: { ticketId, status: "in_progress" }, transaction: u.tx });
    if (!wo) throw new ConflictError("There is no work order in progress");
    // A final cost far above the approved quote needs a fresh decision, not a quiet edit.
    const quoted = wo.get("quotedAmount");
    if (quoted && toMinor(i.finalCost) > Math.round(toMinor(quoted) * 1.1)) throw new ConflictError(`The final cost exceeds the approved quote (${quoted}) by more than 10%; obtain a new approval`);
    const now = new Date();
    await u.repo("WorkOrder").updateById(wo.get("id"), { status: "completed", completedAt: now, finalCost: i.finalCost }, { transaction: u.tx });
    await moveTicket(u, ctx, t, "completed", { resolvedAt: now });
    await event(u, ctx, ticketId, "work_completed", { finalCost: fromMinor(toMinor(i.finalCost)), notes: i.notes }, wo.get("id"));
    await u.emit({ type: "ticket.completed", aggregateType: "ticket", aggregateId: ticketId, payload: { finalCost: fromMinor(toMinor(i.finalCost)) } });
    return getTicketInUow(u, ctx, ticketId);
  });
}

export async function closeTicket(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const t = await scopedTicket(u, ctx, id);
    authorize(ctx, "maintenance.manage", ref(t));
    await moveTicket(u, ctx, t, "closed");
    await event(u, ctx, id, "closed", {});
    return getTicketInUow(u, ctx, id);
  });
}

// ---------------------------------------------------------------- SLA sweep
/** Marks open tickets past their due time exactly once and emits `ticket.sla_breached`. Resolved tickets are measured by resolvedAt vs slaDueAt. */
export async function ticketSlaSweep(sq: Sequelize, ctx: RequestContext, now = new Date()) {
  assertSweepAllowed(ctx, "maintenance.manage");
  return withUow(sq, ctx, async (u) => {
    const late = (await u.repo("Ticket").findAll({ where: { slaBreachedAt: null, status: { [Op.in]: ["new", "triaged", "quoted", "approved", "in_progress"] }, slaDueAt: { [Op.lt]: now } }, transaction: u.tx })) as any[];
    for (const t of late) {
      await u.repo("Ticket").updateById(t.get("id"), { slaBreachedAt: now }, { transaction: u.tx });
      await event(u, ctx, t.get("id"), "sla_breached", { dueAt: t.get("slaDueAt") });
      await u.emit({ type: "ticket.sla_breached", aggregateType: "ticket", aggregateId: t.get("id"), payload: { priority: t.get("priority"), dueAt: t.get("slaDueAt") } });
    }
    return late.length;
  });
}

/** Measurable SLA: share of tickets (resolved or open) that met their deadline. */
export async function slaReport(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "maintenance.read");
  return withUow(sq, ctx, async (u) => {
    const rows = (await u.sq.query<any>(
      `SELECT priority, COUNT(*) total,
              SUM(CASE WHEN resolved_at IS NOT NULL AND resolved_at <= sla_due_at THEN 1 ELSE 0 END) met,
              SUM(CASE WHEN sla_breached_at IS NOT NULL OR (resolved_at IS NOT NULL AND resolved_at > sla_due_at) THEN 1 ELSE 0 END) breached
       FROM maintenance_tickets WHERE tenant_id=:t AND status <> 'cancelled' GROUP BY priority`, { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    return rows.map((r) => ({ priority: r.priority, total: Number(r.total), met: Number(r.met), breached: Number(r.breached) }));
  });
}
