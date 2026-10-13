import { randomUUID } from "node:crypto";
import { Op, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const INSPECTION_SCOPE: ScopeColumns = { owner: "inspectorUserId", branch: "branchId", portfolio: "portfolioId" };
const CONDITIONS = ["good", "fair", "poor", "damaged", "na"] as const;
type Condition = (typeof CONDITIONS)[number];
const ref = (i: any) => ({ ownerUserId: i.get("inspectorUserId"), branchId: i.get("branchId"), portfolioId: i.get("portfolioId") });

export async function createInspectionTemplate(sq: Sequelize, ctx: RequestContext, i: { name: string; kind: "move_in" | "move_out" | "periodic"; items: Array<{ label: string; area?: string }> }) {
  authorize(ctx, "inspection.manage");
  if (!i.items.length) throw new ConflictError("A template needs at least one item");
  return withUow(sq, ctx, async (u) => {
    if (await u.repo("InspectionTemplate").findOne({ where: { name: i.name }, transaction: u.tx })) throw new ConflictError("A template with this name exists");
    return plain(await u.repo("InspectionTemplate").create({ id: randomUUID(), name: i.name, kind: i.kind, items: i.items }, { transaction: u.tx }));
  });
}
export const listInspectionTemplates = (sq: Sequelize, ctx: RequestContext) => {
  authorize(ctx, "inspection.read");
  return withUow(sq, ctx, async (u) => (await u.repo("InspectionTemplate").findAll({ order: [["name", "ASC"]], transaction: u.tx })).map(plain));
};

export async function scheduleInspection(sq: Sequelize, ctx: RequestContext, i: { unitId: string; kind: "move_in" | "move_out" | "periodic"; inspectorUserId: string; templateId?: string; leaseId?: string; scheduledFor?: string }) {
  authorize(ctx, "inspection.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Unit").findById(i.unitId, { transaction: u.tx }))) throw new NotFoundError("Unit");
    if (!(await u.repo("User").findOne({ where: { id: i.inspectorUserId, status: "active" }, transaction: u.tx }))) throw new NotFoundError("Inspector");
    let lease: any = null;
    if (i.leaseId) {
      lease = await u.repo("Lease").findById(i.leaseId, { transaction: u.tx });
      if (!lease || lease.get("unitId") !== i.unitId) throw new NotFoundError("Lease");
    }
    const tpl: any = i.templateId ? await u.repo("InspectionTemplate").findById(i.templateId, { transaction: u.tx }) : null;
    if (i.templateId && !tpl) throw new NotFoundError("Template");
    if (tpl && tpl.get("kind") !== i.kind) throw new ConflictError("The template is for a different inspection kind");
    const owners = (await u.repo("Ownership").findAll({ where: { unitId: i.unitId, toDate: null }, transaction: u.tx })) as any[];
    const portfolioId = lease?.get("portfolioId") ?? (owners.length === 1 ? owners[0].get("portfolioId") : null);
    const id = randomUUID();
    await u.repo("Inspection").create({
      id, unitId: i.unitId, leaseId: i.leaseId ?? null, templateId: i.templateId ?? null, inspectorUserId: i.inspectorUserId, branchId: lease?.get("branchId") ?? ctx.membership.branchIds[0] ?? null,
      portfolioId, kind: i.kind, status: "scheduled", version: 1, scheduledFor: i.scheduledFor ? new Date(i.scheduledFor) : null,
    }, { transaction: u.tx });
    for (const it of (tpl?.get("items") as Array<{ label: string; area?: string }> | undefined) ?? []) {
      await u.repo("InspectionItem").create({ id: randomUUID(), inspectionId: id, label: it.label, area: it.area ?? null, condition: "na" }, { transaction: u.tx });
    }
    await u.audit({ action: "inspection.scheduled", entityType: "inspection", entityId: id, after: { unitId: i.unitId, kind: i.kind } });
    return getInspectionInUow(u, ctx, id);
  });
}

async function scopedInspection(u: Uow, ctx: RequestContext, id: string) {
  const scope = await scopeWhere(u, ctx, "inspection.read", INSPECTION_SCOPE);
  const x: any = await u.repo("Inspection").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!x) throw new NotFoundError("Inspection");
  return x;
}
async function getInspectionInUow(u: Uow, ctx: RequestContext, id: string) {
  const x = await scopedInspection(u, ctx, id);
  const [items, media] = await Promise.all([
    u.repo("InspectionItem").findAll({ where: { inspectionId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
    u.repo("InspectionMedia").findAll({ where: { inspectionId: id }, transaction: u.tx }),
  ]);
  return { ...plain(x), items: items.map(plain), media: media.map(plain) };
}
export const getInspection = (sq: Sequelize, ctx: RequestContext, id: string) => withUow(sq, ctx, (u) => getInspectionInUow(u, ctx, id));

export async function listInspections(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string; unitId?: string }) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "inspection.read", INSPECTION_SCOPE)];
    if (f.status) and.push({ status: f.status });
    if (f.unitId) and.push({ unitId: f.unitId });
    return (await u.repo("Inspection").findAll({ where: { [Op.and]: and }, order: [["createdAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}

export interface ItemChange { itemId: string; condition?: Condition; notes?: string | null; meterReading?: number | null }
export interface Mutation { clientMutationId: string; baseVersion: number; changes: ItemChange[]; addMediaDocumentIds?: Array<{ itemId?: string; documentId: string }> }

export interface SyncResult {
  applied: string[]; duplicates: string[]; conflicts: Array<{ clientMutationId: string; itemId: string; serverVersion: number; reason: string }>; version: number;
}

/**
 * Offline sync. The mobile client replays its journal: each mutation has a client id (replays are no-ops) and the inspection version it was
 * based on. Item edits that touch an item changed on the server since that version are reported as conflicts instead of overwritten.
 * Each item carries the inspection version at which it last changed.
 */
export async function syncInspection(sq: Sequelize, ctx: RequestContext, inspectionId: string, mutations: Mutation[]): Promise<SyncResult> {
  return withUow(sq, ctx, async (u) => {
    const insp = await scopedInspection(u, ctx, inspectionId);
    authorize(ctx, "inspection.perform", ref(insp));
    await u.sq.query("SELECT id FROM inspections WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: inspectionId, t: ctx.tenantId }, transaction: u.tx });
    if (["completed", "signed"].includes(insp.get("status"))) throw new ConflictError("A completed inspection can no longer be edited");
    const result: SyncResult = { applied: [], duplicates: [], conflicts: [], version: Number(insp.get("version")) };
    const seen = new Set(((await u.repo("InspectionMutation").findAll({ where: { inspectionId }, transaction: u.tx })) as any[]).map((h) => h.get("clientMutationId") as string));
    const itemVersion = new Map<string, number>(((await u.repo("InspectionItem").findAll({ where: { inspectionId }, transaction: u.tx })) as any[]).map((it) => [it.get("id") as string, Number(it.get("version"))]));

    for (const m of mutations) {
      if (seen.has(m.clientMutationId)) { result.duplicates.push(m.clientMutationId); continue; }
      let conflicted = false;
      for (const c of m.changes) {
        const serverV = itemVersion.get(c.itemId) ?? 0;
        if (serverV > m.baseVersion) { result.conflicts.push({ clientMutationId: m.clientMutationId, itemId: c.itemId, serverVersion: serverV, reason: "The item changed on the server after your copy" }); conflicted = true; }
      }
      if (conflicted) continue;
      for (const c of m.changes) {
        const item: any = await u.repo("InspectionItem").findOne({ where: { id: c.itemId, inspectionId }, transaction: u.tx });
        if (!item) throw new NotFoundError("Inspection item");
        if (c.condition && !CONDITIONS.includes(c.condition)) throw new ConflictError("Invalid condition");
        const patch: Record<string, unknown> = { version: result.version + 1 };
        if (c.condition !== undefined) patch.condition = c.condition;
        if (c.notes !== undefined) patch.notes = c.notes;
        if (c.meterReading !== undefined) patch.meterReading = c.meterReading;
        await u.repo("InspectionItem").updateById(c.itemId, patch, { transaction: u.tx });
      }
      for (const md of m.addMediaDocumentIds ?? []) {
        if (!(await u.repo("Document").findById(md.documentId, { transaction: u.tx }))) throw new NotFoundError("Document");
        await u.repo("InspectionMedia").create({ id: randomUUID(), inspectionId, itemId: md.itemId ?? null, documentId: md.documentId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
      }
      result.version += 1;
      await u.repo("InspectionMutation").create({ id: randomUUID(), inspectionId, clientMutationId: m.clientMutationId, appliedVersion: result.version, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
      for (const c of m.changes) itemVersion.set(c.itemId, result.version);
      result.applied.push(m.clientMutationId);
    }
    await u.repo("Inspection").updateById(inspectionId, { version: result.version, status: insp.get("status") === "scheduled" ? "in_progress" : insp.get("status") }, { transaction: u.tx });
    return result;
  });
}

export async function completeInspection(sq: Sequelize, ctx: RequestContext, id: string, i: { summary?: string }) {
  return withUow(sq, ctx, async (u) => {
    const x = await scopedInspection(u, ctx, id);
    authorize(ctx, "inspection.perform", ref(x));
    if (!["scheduled", "in_progress"].includes(x.get("status"))) throw new ConflictError("The inspection is already complete");
    const pending = await u.repo("InspectionItem").count({ where: { inspectionId: id, condition: "na" }, transaction: u.tx });
    const total = await u.repo("InspectionItem").count({ where: { inspectionId: id }, transaction: u.tx });
    if (total > 0 && pending === total) throw new ConflictError("Record at least one item before completing");
    await u.repo("Inspection").updateById(id, { status: "completed", completedAt: new Date(), summary: i.summary ?? null, version: Number(x.get("version")) + 1 }, { transaction: u.tx });
    await u.audit({ action: "inspection.completed", entityType: "inspection", entityId: id });
    await u.emit({ type: "inspection.completed", aggregateType: "inspection", aggregateId: id, payload: { kind: x.get("kind"), unitId: x.get("unitId") } });
    return getInspectionInUow(u, ctx, id);
  });
}

export async function signInspection(sq: Sequelize, ctx: RequestContext, id: string, contactId: string) {
  return withUow(sq, ctx, async (u) => {
    const x = await scopedInspection(u, ctx, id);
    authorize(ctx, "inspection.perform", ref(x));
    if (x.get("status") !== "completed") throw new ConflictError("Only a completed inspection can be signed");
    if (!(await u.repo("Contact").findById(contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    await u.repo("Inspection").updateById(id, { status: "signed", signedByContactId: contactId, signedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "inspection.signed", entityType: "inspection", entityId: id, after: { contactId } });
    return getInspectionInUow(u, ctx, id);
  });
}
