import { randomUUID } from "node:crypto";
import { Op, Sequelize, WhereOptions, literal } from "sequelize";
import { mysqlDate, RequestContext, systemContext } from "@reales/database";
import { authorize, can, ForbiddenError, hasPermission, widestScope } from "@reales/rbac";
import { ContactInput, createContactInUow, findDuplicateContacts, CONTACT_SCOPE } from "./contacts";
import { normalizeEmail, normalizePhone } from "./normalize";
import { routeLead } from "./routing";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const LEAD_SCOPE: ScopeColumns = { owner: "assignedUserId", branch: "branchId", project: "projectId" };

export interface LeadInput {
  contactId?: string;
  contact?: ContactInput;
  projectId?: string;
  sourceCode?: string;
  purpose: "buy" | "rent" | "invest" | "off_plan";
  budgetMin?: number; budgetMax?: number; currency?: string;
  preferredAreas?: string[]; bedrooms?: number; language?: string; branchId?: string;
  stageId?: string; assignedUserId?: string; isHot?: boolean; campaign?: string;
}

export interface LeadResult { lead: any; duplicate: boolean; contactReused: boolean; assignedUserId: string | null }

const ref = (l: any) => ({ ownerUserId: l.get("assignedUserId"), branchId: l.get("branchId"), projectId: l.get("projectId") });

async function defaultPipeline(u: Uow, projectId?: string | null) {
  const pipeline: any =
    (projectId && (await u.repo("Pipeline").findOne({ where: { projectId }, transaction: u.tx }))) ||
    (await u.repo("Pipeline").findOne({ where: { isDefault: true }, transaction: u.tx }));
  if (!pipeline) throw new ConflictError("No pipeline configured for this workspace");
  const stages = await u.repo("PipelineStage").findAll({ where: { pipelineId: pipeline.get("id") }, order: [["position", "ASC"]], transaction: u.tx });
  return { pipeline, stages: stages as any[] };
}

/** Core creation, shared by user-created leads and system ingestion. Authorization is the caller's job. */
export async function createLeadCore(u: Uow, ctx: RequestContext, input: LeadInput): Promise<LeadResult> {
  // 1. Contact: reuse an existing person (same email/phone) rather than creating a second record.
  let contact: any;
  let contactReused = false;
  if (input.contactId) {
    contact = await u.repo("Contact").findById(input.contactId, { transaction: u.tx });
    if (!contact) throw new NotFoundError("Contact");
    if (ctx.userId !== "system") {
      const scope = await scopeWhere(u, ctx, "contact.read", CONTACT_SCOPE);
      if (!(await u.repo("Contact").findOne({ where: { [Op.and]: [{ id: input.contactId }, scope] }, transaction: u.tx }))) throw new NotFoundError("Contact");
    }
    contactReused = true;
  } else if (input.contact) {
    const dups = await findDuplicateContacts(u, ctx, normalizeEmail(input.contact.email), normalizePhone(input.contact.phone));
    if (dups.length) {
      contact = [...dups].sort((a: any, b: any) => +new Date(a.get("createdAt")) - +new Date(b.get("createdAt")))[0];
      contactReused = true;
    } else {
      contact = await createContactInUow(u, ctx, { ...input.contact, allowDuplicate: true });
    }
  } else {
    throw new ConflictError("A lead needs a contact");
  }

  if (input.projectId && !(await u.repo("Project").findById(input.projectId, { transaction: u.tx }))) throw new NotFoundError("Project");

  // 2. An open lead for the same person and project is a repeat enquiry, not a new lead.
  const open: any = await u.repo("Lead").findOne({ where: { contactId: contact.get("id"), projectId: input.projectId ?? null, status: "open" }, transaction: u.tx });
  if (open) {
    await addActivityRow(u, open.get("id"), "system", "Repeat enquiry received", ctx);
    await u.emit({ type: "lead.duplicate_enquiry", aggregateType: "lead", aggregateId: open.get("id"), projectId: open.get("projectId"), payload: { contactId: contact.get("id") } });
    return { lead: plain(open), duplicate: true, contactReused, assignedUserId: open.get("assignedUserId") };
  }

  let source: any = null;
  if (input.sourceCode) {
    source = await u.repo("LeadSource").findOne({ where: { code: input.sourceCode }, transaction: u.tx });
    if (!source) throw new NotFoundError("Lead source");
  }
  const { pipeline, stages } = await defaultPipeline(u, input.projectId);
  const first = input.stageId ? stages.find((s) => s.get("id") === input.stageId) : stages.find((s) => s.get("kind") === "open");
  if (!first) throw new ConflictError(input.stageId ? "Unknown stage for this pipeline" : "Pipeline has no open stage");
  if (first.get("kind") !== "open") throw new ConflictError("A new lead must start in an open stage");

  // An explicit owner must be someone the creator is allowed to assign to (admin: anyone, manager: own branch/unit, agent: self).
  if (input.assignedUserId && ctx.userId !== "system" && !(await assignableUsersIn(u, ctx)).some((x) => x.id === input.assignedUserId)) throw new ForbiddenError("You cannot assign a lead to that user");

  const id = randomUUID();
  const language = input.language ?? contact.get("language") ?? null;
  const branchId = input.branchId ?? contact.get("branchId") ?? ctx.membership.branchIds[0] ?? null;
  await u.repo("Lead").create({
    id, contactId: contact.get("id"), projectId: input.projectId ?? null, sourceId: source?.get("id") ?? null,
    pipelineId: pipeline.get("id"), stageId: first.get("id"), status: "open", purpose: input.purpose,
    budgetMin: input.budgetMin ?? null, budgetMax: input.budgetMax ?? null, currency: input.currency ?? "AED",
    preferredAreas: input.preferredAreas ?? null, bedrooms: input.bedrooms ?? null, language, branchId,
    isHot: input.isHot ?? false, campaign: input.campaign?.trim() || null,
  }, { transaction: u.tx });
  await u.repo("LeadStageEvent").create({ id: randomUUID(), leadId: id, fromStageId: null, toStageId: first.get("id"), actorId: actorOf(ctx), reason: "created", createdAt: mysqlDate(new Date()) }, { transaction: u.tx });

  // 3. Route to an agent.
  const decision = input.assignedUserId
    ? { userId: input.assignedUserId, ruleId: null as string | null, method: "manual" as const, reason: "Chosen when the lead was created" }
    : await routeLead(u, ctx, {
    purpose: input.purpose, projectId: input.projectId ?? null, language, budgetMin: input.budgetMin ?? null, budgetMax: input.budgetMax ?? null,
    sourceKind: source?.get("kind") ?? null, sourceCode: source?.get("code") ?? null,
  });
  let assignedBranch = branchId;
  if (decision.userId) {
    const agent: any = await u.repo("User").findById(decision.userId, { transaction: u.tx });
    assignedBranch = agent?.get("branchId") ?? branchId;
    await u.repo("Lead").updateById(id, { assignedUserId: decision.userId, branchId: assignedBranch }, { transaction: u.tx });
  }
  await u.repo("LeadAssignment").create({
    id: randomUUID(), leadId: id, assignedUserId: decision.userId, previousUserId: null, ruleId: decision.ruleId, method: decision.method,
    reason: decision.reason, actorId: actorOf(ctx), createdAt: mysqlDate(new Date()),
  }, { transaction: u.tx });

  await u.emit({ type: "lead.created", aggregateType: "lead", aggregateId: id, projectId: input.projectId ?? null, payload: { contactId: contact.get("id"), purpose: input.purpose, source: source?.get("code") ?? null } });
  if (decision.userId) await u.emit({ type: "lead.assigned", aggregateType: "lead", aggregateId: id, projectId: input.projectId ?? null, payload: { userId: decision.userId, method: decision.method } });
  const lead = await u.repo("Lead").findById(id, { transaction: u.tx });
  return { lead: plain(lead), duplicate: false, contactReused, assignedUserId: decision.userId };
}

const actorOf = (ctx: Pick<RequestContext, "userId">) => (ctx.userId === "system" ? null : ctx.userId);

async function addActivityRow(u: Uow, leadId: string, kind: string, summary: string, ctx: Pick<RequestContext, "userId">) {
  const now = mysqlDate(new Date());
  await u.repo("Activity").create({ id: randomUUID(), entityType: "lead", entityId: leadId, kind, summary, actorId: actorOf(ctx), occurredAt: now, createdAt: now }, { transaction: u.tx });
}

/** Users the caller may assign a lead to: tenant scope = everyone active, business unit/branch scope = that unit or branch (their team), otherwise only themselves. */
async function assignableUsersIn(u: Uow, ctx: RequestContext) {
  const scope = widestScope(ctx, "lead.assign");
  const t = ctx.tenantId.replace(/[^a-f0-9-]/gi, "");
  const and: WhereOptions[] = [{ status: "active" }, literal(`id NOT IN (SELECT user_id FROM portal_links WHERE tenant_id = '${t}')`)];
  if (scope === "business_unit") and.push({ [Op.or]: [{ businessUnitId: { [Op.in]: ctx.membership.businessUnitIds.length ? ctx.membership.businessUnitIds : ["-"] } }, { id: ctx.userId }] });
  else if (scope === "branch") and.push({ [Op.or]: [{ branchId: { [Op.in]: ctx.membership.branchIds.length ? ctx.membership.branchIds : ["-"] } }, { id: ctx.userId }] });
  else if (scope !== "tenant") and.push({ id: ctx.userId });
  const rows = await u.repo("User").findAll({ where: { [Op.and]: and }, order: [["email", "ASC"]], transaction: u.tx });
  return rows.map((r: any) => ({ id: r.get("id") as string, email: r.get("email") as string, branchId: r.get("branchId") as string | null }));
}

export async function listAssignableUsers(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, (u) => assignableUsersIn(u, ctx));
}

export async function createLead(sq: Sequelize, ctx: RequestContext, input: LeadInput) {
  authorize(ctx, "lead.create");
  return withUow(sq, ctx, (u) => createLeadCore(u, ctx, input));
}

/** Inbound lead from a trusted integration (portal, web form, WhatsApp). The caller must have authenticated the channel. */
export async function ingestLead(sq: Sequelize, tenantId: string, input: LeadInput, correlationId = `corr_${randomUUID()}`) {
  const ctx = systemContext(tenantId, correlationId);
  return withUow(sq, ctx, (u) => createLeadCore(u, ctx, input));
}

export async function listLeads(sq: Sequelize, ctx: RequestContext, opts: { limit: number; offset: number; status?: string; stageKey?: string; mine?: boolean }) {
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
    const and: WhereOptions[] = [scope];
    if (opts.status) and.push({ status: opts.status });
    if (opts.mine) and.push({ assignedUserId: ctx.userId });
    if (opts.stageKey) {
      const stages = await u.repo("PipelineStage").findAll({ where: { key: opts.stageKey }, transaction: u.tx });
      and.push({ stageId: { [Op.in]: stages.length ? stages.map((s: any) => s.get("id")) : ["-"] } });
    }
    const rows = await u.repo("Lead").findAll({ where: { [Op.and]: and }, order: [["createdAt", "DESC"]], limit: opts.limit, offset: opts.offset, transaction: u.tx });
    return rows.map(plain);
  });
}

async function scopedLead(u: Uow, ctx: RequestContext, id: string) {
  const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
  const lead: any = await u.repo("Lead").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!lead) throw new NotFoundError("Lead");
  return lead;
}

export async function getLead(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const lead = await scopedLead(u, ctx, id);
    const [stageEvents, assignments, activities] = await Promise.all([
      u.repo("LeadStageEvent").findAll({ where: { leadId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
      u.repo("LeadAssignment").findAll({ where: { leadId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
      u.repo("Activity").findAll({ where: { entityType: "lead", entityId: id }, order: [["occurredAt", "DESC"]], limit: 50, transaction: u.tx }),
    ]);
    return { ...plain(lead), stageEvents: stageEvents.map(plain), assignments: assignments.map(plain), activities: activities.map(plain) };
  });
}

export async function updateLead(sq: Sequelize, ctx: RequestContext, id: string, patch: Partial<Pick<LeadInput, "budgetMin" | "budgetMax" | "currency" | "preferredAreas" | "bedrooms" | "language" | "purpose">>) {
  return withUow(sq, ctx, async (u) => {
    const lead = await scopedLead(u, ctx, id);
    authorize(ctx, "lead.update", ref(lead));
    await u.repo("Lead").updateById(id, patch as Record<string, unknown>, { transaction: u.tx });
    await u.emit({ type: "lead.updated", aggregateType: "lead", aggregateId: id, projectId: lead.get("projectId"), payload: { fields: Object.keys(patch) } });
    return plain(await u.repo("Lead").findById(id, { transaction: u.tx }));
  });
}

/** Move a lead through its pipeline. Explicit history goes to lead_stage_events; leads.stage_id is only the projection. */
export async function changeLeadStage(sq: Sequelize, ctx: RequestContext, id: string, input: { stageKey: string; reason?: string }) {
  return withUow(sq, ctx, async (u) => {
    const lead = await scopedLead(u, ctx, id);
    authorize(ctx, "lead.update", ref(lead));
    const target: any = await u.repo("PipelineStage").findOne({ where: { pipelineId: lead.get("pipelineId"), key: input.stageKey }, transaction: u.tx });
    if (!target) throw new NotFoundError("Stage");
    const fromId = lead.get("stageId");
    if (fromId === target.get("id")) return plain(lead);
    if (target.get("kind") === "lost" && !input.reason?.trim()) throw new ConflictError("A loss reason is required");
    // Re-opening a closed lead is a manager decision.
    if (lead.get("status") !== "open" && target.get("kind") === "open") authorize(ctx, "lead.assign", ref(lead));
    const status = target.get("kind");
    await u.repo("Lead").updateById(id, { stageId: target.get("id"), status, lostReason: status === "lost" ? input.reason!.trim() : null }, { transaction: u.tx });
    await u.repo("LeadStageEvent").create({ id: randomUUID(), leadId: id, fromStageId: fromId, toStageId: target.get("id"), actorId: actorOf(ctx), reason: input.reason ?? null, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    if (status !== "open") await u.audit({ action: `lead.${status}`, entityType: "lead", entityId: id, after: { stage: input.stageKey, reason: input.reason ?? null } });
    await u.emit({ type: "lead.stage_changed", aggregateType: "lead", aggregateId: id, projectId: lead.get("projectId"), payload: { from: fromId, to: target.get("id"), stageKey: input.stageKey, status } });
    return plain(await u.repo("Lead").findById(id, { transaction: u.tx }));
  });
}

export async function assignLead(sq: Sequelize, ctx: RequestContext, id: string, input: { userId: string | null; reason?: string }) {
  return withUow(sq, ctx, async (u) => {
    const lead = await scopedLead(u, ctx, id);
    authorize(ctx, "lead.assign", ref(lead));
    let branchId = lead.get("branchId");
    if (input.userId) {
      const agent: any = await u.repo("User").findOne({ where: { id: input.userId, status: "active" }, transaction: u.tx });
      if (!agent) throw new NotFoundError("User");
      branchId = agent.get("branchId") ?? branchId;
    }
    const previous = lead.get("assignedUserId");
    await u.repo("Lead").updateById(id, { assignedUserId: input.userId, branchId }, { transaction: u.tx });
    await u.repo("LeadAssignment").create({ id: randomUUID(), leadId: id, assignedUserId: input.userId, previousUserId: previous, ruleId: null, method: "manual", reason: input.reason ?? null, actorId: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.audit({ action: "lead.reassigned", entityType: "lead", entityId: id, before: { userId: previous }, after: { userId: input.userId }, reason: input.reason });
    await u.emit({ type: "lead.assigned", aggregateType: "lead", aggregateId: id, projectId: lead.get("projectId"), payload: { userId: input.userId, previous, method: "manual" } });
    return plain(await u.repo("Lead").findById(id, { transaction: u.tx }));
  });
}

export async function addLeadActivity(sq: Sequelize, ctx: RequestContext, id: string, input: { kind: "note" | "call" | "whatsapp" | "email" | "sms" | "viewing"; summary: string }) {
  return withUow(sq, ctx, async (u) => {
    const lead = await scopedLead(u, ctx, id);
    authorize(ctx, "lead.update", ref(lead));
    await addActivityRow(u, id, input.kind, input.summary, ctx);
    // The first outbound touch by a person starts the response-SLA clock's "answered" state.
    if (["call", "whatsapp", "email", "sms"].includes(input.kind) && !lead.get("firstResponseAt")) {
      await u.repo("Lead").updateById(id, { firstResponseAt: new Date() }, { transaction: u.tx });
      await u.emit({ type: "lead.first_response", aggregateType: "lead", aggregateId: id, projectId: lead.get("projectId"), payload: { kind: input.kind } });
    }
  });
}

export async function createTask(sq: Sequelize, ctx: RequestContext, input: { title: string; leadId?: string; assigneeId?: string; dueAt?: string }) {
  return withUow(sq, ctx, async (u) => {
    if (input.leadId) {
      const lead = await scopedLead(u, ctx, input.leadId);
      authorize(ctx, "lead.update", ref(lead));
    }
    const assignee = input.assigneeId ?? ctx.userId;
    if (assignee !== ctx.userId && !can(ctx, "lead.assign")) throw new ForbiddenError("Missing permission: lead.assign");
    if (!(await u.repo("User").findById(assignee, { transaction: u.tx }))) throw new NotFoundError("User");
    const t = await u.repo("Task").create({ id: randomUUID(), title: input.title, leadId: input.leadId ?? null, assigneeId: assignee, dueAt: input.dueAt ? new Date(input.dueAt) : null, status: "open" }, { transaction: u.tx });
    return plain(t);
  });
}

export async function completeTask(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const t: any = await u.repo("Task").findById(id, { transaction: u.tx });
    if (!t || (t.get("assigneeId") !== ctx.userId && !can(ctx, "lead.assign"))) throw new NotFoundError("Task");
    await u.repo("Task").updateById(id, { status: "done", completedAt: new Date() }, { transaction: u.tx });
    return plain(await u.repo("Task").findById(id, { transaction: u.tx }));
  });
}

export async function listPipelines(sq: Sequelize, ctx: RequestContext) {
  if (!hasPermission(ctx, "lead.read")) throw new ForbiddenError("Missing permission: lead.read");
  return withUow(sq, ctx, async (u) => {
    const pipelines = await u.repo("Pipeline").findAll({ transaction: u.tx });
    const stages = await u.repo("PipelineStage").findAll({ order: [["position", "ASC"]], transaction: u.tx });
    return pipelines.map((p: any) => ({ ...plain(p), stages: stages.filter((s: any) => s.get("pipelineId") === p.get("id")).map(plain) }));
  });
}

/** When a deal closes, the originating lead is won: stage projection + explicit history in the same transaction. */
export async function closeLeadAsWon(u: Uow, ctx: RequestContext, leadId: string) {
  const lead: any = await u.repo("Lead").findById(leadId, { transaction: u.tx });
  if (!lead || lead.get("status") === "won") return;
  const won: any = await u.repo("PipelineStage").findOne({ where: { pipelineId: lead.get("pipelineId"), kind: "won" }, transaction: u.tx });
  if (!won) return;
  await u.repo("Lead").updateById(leadId, { stageId: won.get("id"), status: "won", lostReason: null }, { transaction: u.tx });
  await u.repo("LeadStageEvent").create({ id: randomUUID(), leadId, fromStageId: lead.get("stageId"), toStageId: won.get("id"), actorId: actorOf(ctx), reason: "deal closed", createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
  await u.emit({ type: "lead.stage_changed", aggregateType: "lead", aggregateId: leadId, projectId: lead.get("projectId"), payload: { to: won.get("id"), stageKey: won.get("key"), status: "won" } });
}
