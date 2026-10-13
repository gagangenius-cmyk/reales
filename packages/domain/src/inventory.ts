import { randomUUID } from "node:crypto";
import { Op, Sequelize, WhereOptions } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize, ForbiddenError, hasPermission } from "@reales/rbac";
import { unpublishListingInUow } from "./listings";
import { plain } from "./scope";
import { ConflictError, NotFoundError, QuotaExceededError, Uow, withUow } from "./uow";

const readable = (ctx: RequestContext) => {
  if (!hasPermission(ctx, "inventory.read") && !hasPermission(ctx, "inventory.manage")) throw new ForbiddenError("Missing permission: inventory.read");
};

export async function createDeveloper(sq: Sequelize, ctx: RequestContext, i: { name: string; registrationNo?: string; jurisdictionCode: string; escrowRegistered?: boolean }) {
  authorize(ctx, "inventory.manage");
  return withUow(sq, ctx, async (u) => {
    const d = await u.repo("Developer").create({ id: randomUUID(), name: i.name, registrationNo: i.registrationNo ?? null, jurisdictionCode: i.jurisdictionCode, escrowRegistered: i.escrowRegistered ?? false }, { transaction: u.tx });
    await u.audit({ action: "developer.created", entityType: "developer", entityId: (d as any).get("id"), after: i });
    return plain(d);
  });
}

export interface ReProjectInput {
  name: string; jurisdictionCode: string; kind: "ready" | "off_plan"; developerId?: string; crmProjectId?: string;
  registrationNo?: string; escrowAccountRef?: string; handoverDate?: string;
}

export async function createReProject(sq: Sequelize, ctx: RequestContext, i: ReProjectInput) {
  authorize(ctx, "inventory.manage");
  return withUow(sq, ctx, async (u) => {
    if (i.developerId && !(await u.repo("Developer").findById(i.developerId, { transaction: u.tx }))) throw new NotFoundError("Developer");
    if (i.crmProjectId && !(await u.repo("Project").findById(i.crmProjectId, { transaction: u.tx }))) throw new NotFoundError("Project");
    const p = await u.repo("ReProject").create({
      id: randomUUID(), name: i.name, jurisdictionCode: i.jurisdictionCode, kind: i.kind, developerId: i.developerId ?? null, crmProjectId: i.crmProjectId ?? null,
      registrationNo: i.registrationNo ?? null, escrowAccountRef: i.escrowAccountRef ?? null, handoverDate: i.handoverDate ?? null, status: "selling",
    }, { transaction: u.tx });
    await u.audit({ action: "re_project.created", entityType: "re_project", entityId: (p as any).get("id"), after: i });
    await u.emit({ type: "project.registered", aggregateType: "re_project", aggregateId: (p as any).get("id"), payload: { kind: i.kind, jurisdiction: i.jurisdictionCode } });
    return plain(p);
  });
}

export async function createBuilding(sq: Sequelize, ctx: RequestContext, i: { reProjectId: string; name: string; community?: string; city?: string; floorsCount?: number }) {
  authorize(ctx, "inventory.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("ReProject").findById(i.reProjectId, { transaction: u.tx }))) throw new NotFoundError("Project");
    return plain(await u.repo("Building").create({ id: randomUUID(), reProjectId: i.reProjectId, name: i.name, community: i.community ?? null, city: i.city ?? null, floorsCount: i.floorsCount ?? null }, { transaction: u.tx }));
  });
}

export interface UnitInput {
  buildingId: string; unitNumber: string; floor?: number; type: "apartment" | "villa" | "townhouse" | "penthouse" | "office" | "retail" | "land";
  bedrooms?: number; bathrooms?: number; areaSqft?: number; view?: string; listPrice?: number; currency?: string; ownerContactId?: string;
}

export async function createUnit(sq: Sequelize, ctx: RequestContext, i: UnitInput) {
  authorize(ctx, "inventory.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Building").findById(i.buildingId, { transaction: u.tx }))) throw new NotFoundError("Building");
    if (i.ownerContactId && !(await u.repo("Contact").findById(i.ownerContactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    const q: any = await u.repo("TenantQuota").findOne({ where: { quotaKey: "units" }, transaction: u.tx });
    if (q && (await u.repo("Unit").count({ transaction: u.tx })) >= Number(q.get("limitValue"))) throw new QuotaExceededError("units", Number(q.get("limitValue")));
    if (await u.repo("Unit").findOne({ where: { buildingId: i.buildingId, unitNumber: i.unitNumber }, transaction: u.tx })) throw new ConflictError("This unit number already exists in the building");
    const unit = await u.repo("Unit").create({
      id: randomUUID(), buildingId: i.buildingId, unitNumber: i.unitNumber, floor: i.floor ?? null, type: i.type, bedrooms: i.bedrooms ?? null, bathrooms: i.bathrooms ?? null,
      areaSqft: i.areaSqft ?? null, view: i.view ?? null, status: "available", listPrice: i.listPrice ?? null, currency: i.currency ?? "AED", ownerContactId: i.ownerContactId ?? null,
    }, { transaction: u.tx });
    await u.emit({ type: "unit.created", aggregateType: "unit", aggregateId: (unit as any).get("id"), payload: { buildingId: i.buildingId } });
    return plain(unit);
  });
}

/** Allowed unit status moves. Anything else is a data error (e.g. selling a blocked unit). */
export const UNIT_TRANSITIONS: Record<string, string[]> = {
  available: ["reserved", "sold", "rented", "blocked"],
  reserved: ["available", "sold", "rented"],
  blocked: ["available"],
  sold: ["available"], // cancellation / fall-through, audited
  rented: ["available"], // lease ended
};

/** Status change inside an existing unit of work (deals, reservations). Caller authorises. */
export async function setUnitStatusInUow(u: Uow, ctx: RequestContext, unitId: string, to: "available" | "reserved" | "sold" | "rented" | "blocked", reason?: string) {
  const unit: any = await u.repo("Unit").findById(unitId, { transaction: u.tx });
  if (!unit) throw new NotFoundError("Unit");
  const from = unit.get("status") as string;
  if (from === to) return unit;
  if (!UNIT_TRANSITIONS[from]?.includes(to)) throw new ConflictError(`A ${from} unit cannot become ${to}`);
  // Row lock so two concurrent reservations of the same unit cannot both succeed.
  await u.sq.query("SELECT id FROM units WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: unitId, t: ctx.tenantId }, transaction: u.tx });
  await u.repo("Unit").updateById(unitId, { status: to }, { transaction: u.tx });
  if (to !== "available") {
    // A unit that is no longer available must not stay advertised.
    const live = await u.repo("Listing").findAll({ where: { unitId, status: "published" }, transaction: u.tx });
    for (const l of live as any[]) await unpublishListingInUow(u, ctx, l, `unit became ${to}`);
  }
  await u.audit({ action: "unit.status_changed", entityType: "unit", entityId: unitId, before: { status: from }, after: { status: to }, reason });
  await u.emit({ type: "unit.status_changed", aggregateType: "unit", aggregateId: unitId, payload: { from, to } });
  return u.repo("Unit").findById(unitId, { transaction: u.tx });
}

export async function setUnitStatus(sq: Sequelize, ctx: RequestContext, unitId: string, to: "available" | "reserved" | "sold" | "rented" | "blocked", reason?: string) {
  authorize(ctx, "inventory.manage");
  return withUow(sq, ctx, async (u: Uow) => plain(await setUnitStatusInUow(u, ctx, unitId, to, reason)));
}

export interface UnitFilter { limit: number; offset: number; status?: string; type?: string; bedrooms?: number; minPrice?: number; maxPrice?: number; buildingId?: string; reProjectId?: string }

export async function listUnits(sq: Sequelize, ctx: RequestContext, f: UnitFilter) {
  readable(ctx);
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [];
    if (f.status) and.push({ status: f.status });
    if (f.type) and.push({ type: f.type });
    if (f.bedrooms !== undefined) and.push({ bedrooms: f.bedrooms });
    if (f.minPrice !== undefined) and.push({ listPrice: { [Op.gte]: f.minPrice } });
    if (f.maxPrice !== undefined) and.push({ listPrice: { [Op.lte]: f.maxPrice } });
    if (f.buildingId) and.push({ buildingId: f.buildingId });
    if (f.reProjectId) {
      const buildings = await u.repo("Building").findAll({ where: { reProjectId: f.reProjectId }, transaction: u.tx });
      and.push({ buildingId: { [Op.in]: buildings.length ? buildings.map((b: any) => b.get("id")) : ["-"] } });
    }
    return (await u.repo("Unit").findAll({ where: { [Op.and]: and }, order: [["createdAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}

export async function listInventoryTree(sq: Sequelize, ctx: RequestContext) {
  readable(ctx);
  return withUow(sq, ctx, async (u) => ({
    developers: (await u.repo("Developer").findAll({ transaction: u.tx })).map(plain),
    projects: (await u.repo("ReProject").findAll({ transaction: u.tx })).map(plain),
    buildings: (await u.repo("Building").findAll({ transaction: u.tx })).map(plain),
  }));
}
