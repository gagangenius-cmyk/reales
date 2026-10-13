import { Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize, widestScope, ForbiddenError } from "@reales/rbac";
import { ConflictError, NotFoundError, withUow, assertQuota } from "./uow";

const plain = (m: any) => m.get({ plain: true });

export async function createBusinessUnit(sq: Sequelize, ctx: RequestContext, i: { name: string; type: "brokerage" | "property_management" | "developer" }) {
  authorize(ctx, "org.manage");
  return withUow(sq, ctx, async (u) => {
    const bu = await u.repo("BusinessUnit").create(i, { transaction: u.tx });
    await u.audit({ action: "business_unit.created", entityType: "business_unit", entityId: (bu as any).get("id"), after: i });
    await u.emit({ type: "business_unit.created", aggregateType: "business_unit", aggregateId: (bu as any).get("id"), payload: i });
    return plain(bu);
  });
}

export async function createBranch(sq: Sequelize, ctx: RequestContext, i: { businessUnitId: string; name: string; city?: string }) {
  authorize(ctx, "org.manage");
  return withUow(sq, ctx, async (u) => {
    // The parent must belong to THIS tenant - a foreign id simply is not found.
    if (!(await u.repo("BusinessUnit").findById(i.businessUnitId, { transaction: u.tx }))) throw new NotFoundError("Business unit");
    const b = await u.repo("Branch").create({ ...i, city: i.city ?? null }, { transaction: u.tx });
    await u.audit({ action: "branch.created", entityType: "branch", entityId: (b as any).get("id"), after: i });
    await u.emit({ type: "branch.created", aggregateType: "branch", aggregateId: (b as any).get("id"), payload: i });
    return plain(b);
  });
}

export async function createTeam(sq: Sequelize, ctx: RequestContext, i: { branchId?: string; name: string }) {
  authorize(ctx, "org.manage");
  return withUow(sq, ctx, async (u) => {
    if (i.branchId && !(await u.repo("Branch").findById(i.branchId, { transaction: u.tx }))) throw new NotFoundError("Branch");
    const t = await u.repo("Team").create({ branchId: i.branchId ?? null, name: i.name }, { transaction: u.tx });
    await u.audit({ action: "team.created", entityType: "team", entityId: (t as any).get("id"), after: i });
    return plain(t);
  });
}

export async function addTeamMember(sq: Sequelize, ctx: RequestContext, teamId: string, userId: string) {
  authorize(ctx, "org.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Team").findById(teamId, { transaction: u.tx }))) throw new NotFoundError("Team");
    if (!(await u.repo("User").findById(userId, { transaction: u.tx }))) throw new NotFoundError("User");
    await u.repo("TeamMember").create({ teamId, userId }, { transaction: u.tx });
    await u.audit({ action: "team.member_added", entityType: "team", entityId: teamId, after: { userId } });
  });
}

export async function listOrg(sq: Sequelize, ctx: RequestContext) {
  if (!widestScope(ctx, "org.read")) throw new ForbiddenError("Missing permission: org.read");
  return withUow(sq, ctx, async (u) => ({
    businessUnits: (await u.repo("BusinessUnit").findAll({ transaction: u.tx })).map(plain),
    branches: (await u.repo("Branch").findAll({ transaction: u.tx })).map(plain),
    teams: (await u.repo("Team").findAll({ transaction: u.tx })).map(plain),
  }));
}

export async function createProject(sq: Sequelize, ctx: RequestContext, i: { code: string; name: string; kind?: "project" | "portfolio" | "workspace"; businessUnitId?: string }) {
  authorize(ctx, "project.manage");
  return withUow(sq, ctx, async (u) => {
    await assertQuota(u, ctx, "projects", "projects");
    if (i.businessUnitId && !(await u.repo("BusinessUnit").findById(i.businessUnitId, { transaction: u.tx }))) throw new NotFoundError("Business unit");
    if (await u.repo("Project").findOne({ where: { code: i.code }, transaction: u.tx })) throw new ConflictError("Project code already exists");
    const p = await u.repo("Project").create({ kind: i.kind ?? "project", code: i.code, name: i.name, businessUnitId: i.businessUnitId ?? null, status: "active" }, { transaction: u.tx });
    const id = (p as any).get("id");
    await u.audit({ action: "project.created", entityType: "project", entityId: id, after: i });
    await u.emit({ type: "project.created", aggregateType: "project", aggregateId: id, projectId: id, payload: i });
    return plain(p);
  });
}

export async function updateProject(sq: Sequelize, ctx: RequestContext, id: string, i: { name?: string; status?: "active" | "archived" }) {
  return withUow(sq, ctx, async (u) => {
    const p: any = await u.repo("Project").findById(id, { transaction: u.tx });
    if (!p) throw new NotFoundError("Project");
    authorize(ctx, "project.manage", { projectId: id });
    await u.repo("Project").updateById(id, i, { transaction: u.tx });
    await u.audit({ action: "project.updated", entityType: "project", entityId: id, before: { name: p.get("name"), status: p.get("status") }, after: i });
    await u.emit({ type: "project.updated", aggregateType: "project", aggregateId: id, projectId: id, payload: i });
    return plain(await u.repo("Project").findById(id, { transaction: u.tx }));
  });
}

export async function listProjects(sq: Sequelize, ctx: RequestContext) {
  if (!widestScope(ctx, "project.read")) throw new ForbiddenError("Missing permission: project.read");
  return withUow(sq, ctx, async (u) => (await u.repo("Project").findAll({ order: [["createdAt", "DESC"]], transaction: u.tx })).map(plain));
}

export async function listAuditEvents(sq: Sequelize, ctx: RequestContext, opts: { limit: number; offset: number }) {
  authorize(ctx, "audit.read");
  return withUow(sq, ctx, async (u) =>
    (await u.repo("AuditEvent").findAll({ order: [["seq", "DESC"]], limit: opts.limit, offset: opts.offset, transaction: u.tx })).map(plain),
  );
}

export async function getUsage(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "tenant.manage");
  return withUow(sq, ctx, async (u) => ({
    quotas: (await u.repo("TenantQuota").findAll({ transaction: u.tx })).map(plain),
    entitlements: (await u.repo("TenantEntitlement").findAll({ transaction: u.tx })).map(plain),
    meters: (await u.repo("UsageMeter").findAll({ transaction: u.tx })).map(plain),
  }));
}
