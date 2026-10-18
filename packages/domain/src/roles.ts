import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { requireStepUp } from "@reales/auth";
import { authorize, ForbiddenError, holdsAtLeast, PERMISSIONS } from "@reales/rbac";
import { ConflictError, NotFoundError, withUow } from "./uow";

export const GRANT_SCOPES = ["tenant", "business_unit", "branch", "project", "portfolio", "own_records"] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];
export interface GrantInput { permission: string; scope: GrantScope }

const titleCase = (s: string) => s.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** The permission catalogue grouped by module (the part of the key before the first dot), each with its actions. */
export function permissionCatalogue() {
  const modules = new Map<string, { key: string; action: string; description: string }[]>();
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    const [module, ...rest] = key.split(".");
    const list = modules.get(module!) ?? [];
    list.push({ key, action: titleCase(rest.join(".") || module!), description });
    modules.set(module!, list);
  }
  return [...modules.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([module, permissions]) => ({ module, title: titleCase(module), permissions }));
}

export async function getRoleGrants(sq: Sequelize, ctx: RequestContext, roleId: string) {
  authorize(ctx, "role.read");
  const rows = await sq.query<{ permission: string; scope: GrantScope }>(
    "SELECT p.`key` AS permission, rp.scope FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.tenant_id=:t AND rp.role_id=:r ORDER BY p.`key`",
    { replacements: { t: ctx.tenantId, r: roleId }, type: QueryTypes.SELECT },
  );
  return rows;
}

function validateGrants(ctx: RequestContext, grants: GrantInput[]) {
  const seen = new Set<string>();
  for (const g of grants) {
    if (!(g.permission in PERMISSIONS)) throw new ConflictError(`Unknown permission ${g.permission}`);
    if (!GRANT_SCOPES.includes(g.scope)) throw new ConflictError(`Unknown scope ${g.scope}`);
    if (seen.has(g.permission)) throw new ConflictError(`Duplicate permission ${g.permission}`);
    seen.add(g.permission);
  }
  // Privilege-escalation guard: you can only put a permission into a role at a scope you hold yourself, or a narrower one.
  const missing = grants.filter((g) => !holdsAtLeast(ctx, g.permission, g.scope)).map((g) => `${g.permission} (${g.scope})`);
  if (missing.length) throw new ForbiddenError(`You cannot grant permissions you do not hold: ${missing.slice(0, 3).join(", ")}`);
}

async function writeGrants(sq: Sequelize, ctx: RequestContext, roleId: string, grants: GrantInput[], tx: unknown) {
  await sq.query("DELETE FROM role_permissions WHERE tenant_id=:t AND role_id=:r", { replacements: { t: ctx.tenantId, r: roleId }, transaction: tx as never });
  for (const g of grants) {
    await sq.query(
      `INSERT INTO role_permissions (id, tenant_id, role_id, permission_id, scope, created_at, updated_at)
       SELECT :id, :t, :r, p.id, :scope, NOW(3), NOW(3) FROM permissions p WHERE p.\`key\` = :perm`,
      { replacements: { id: randomUUID(), t: ctx.tenantId, r: roleId, scope: g.scope, perm: g.permission }, transaction: tx as never },
    );
  }
}

/** Create a custom role (for example "Senior Agent"). System roles come from the seeder and cannot be edited, only copied. */
export async function createCustomRole(sq: Sequelize, ctx: RequestContext, i: { name: string; key?: string; requiresMfa?: boolean; grants: GrantInput[]; copyFromRoleId?: string }) {
  authorize(ctx, "role.manage");
  requireStepUp(ctx);
  const key = (i.key ?? i.name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
  if (!key) throw new ConflictError("A role needs a name");
  return withUow(sq, ctx, async (u) => {
    if (await u.repo("Role").findOne({ where: { key }, transaction: u.tx })) throw new ConflictError("A role with this name already exists");
    let grants = i.grants;
    if (i.copyFromRoleId) {
      if (!(await u.repo("Role").findById(i.copyFromRoleId, { transaction: u.tx }))) throw new NotFoundError("Role");
      grants = (await sq.query<GrantInput>("SELECT p.`key` AS permission, rp.scope FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.tenant_id=:t AND rp.role_id=:r", { replacements: { t: ctx.tenantId, r: i.copyFromRoleId }, transaction: u.tx, type: QueryTypes.SELECT }));
    }
    validateGrants(ctx, grants);
    const id = randomUUID();
    await u.repo("Role").create({ id, key, name: i.name.trim(), isSystem: false, requiresMfa: i.requiresMfa ?? false }, { transaction: u.tx });
    await writeGrants(sq, ctx, id, grants, u.tx);
    await u.audit({ action: "role.created", entityType: "role", entityId: id, after: { key, grants: grants.length } });
    return { id, key, name: i.name.trim() };
  });
}

/** Replace the permission matrix of a custom role. Takes effect on the next request of every user holding it. */
export async function setRoleGrants(sq: Sequelize, ctx: RequestContext, roleId: string, input: { grants: GrantInput[]; name?: string; requiresMfa?: boolean }) {
  authorize(ctx, "role.manage");
  requireStepUp(ctx);
  return withUow(sq, ctx, async (u) => {
    const role: any = await u.repo("Role").findById(roleId, { transaction: u.tx });
    if (!role) throw new NotFoundError("Role");
    if (role.get("isSystem")) throw new ConflictError("System roles are fixed. Duplicate the role to customise it.");
    validateGrants(ctx, input.grants);
    const before = await sq.query<GrantInput>("SELECT p.`key` AS permission, rp.scope FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.tenant_id=:t AND rp.role_id=:r", { replacements: { t: ctx.tenantId, r: roleId }, transaction: u.tx, type: QueryTypes.SELECT });
    await writeGrants(sq, ctx, roleId, input.grants, u.tx);
    const patch: Record<string, unknown> = {};
    if (input.name?.trim()) patch.name = input.name.trim();
    if (input.requiresMfa !== undefined) patch.requiresMfa = input.requiresMfa;
    if (Object.keys(patch).length) await u.repo("Role").updateById(roleId, patch, { transaction: u.tx });
    await u.audit({ action: "role.permissions_changed", entityType: "role", entityId: roleId, before: { grants: before }, after: { grants: input.grants } });
    return { id: roleId, grants: input.grants.length };
  });
}

export async function deleteCustomRole(sq: Sequelize, ctx: RequestContext, roleId: string) {
  authorize(ctx, "role.manage");
  requireStepUp(ctx);
  return withUow(sq, ctx, async (u) => {
    const role: any = await u.repo("Role").findById(roleId, { transaction: u.tx });
    if (!role) throw new NotFoundError("Role");
    if (role.get("isSystem")) throw new ConflictError("System roles cannot be deleted");
    if (await u.repo("UserRole").findOne({ where: { roleId }, transaction: u.tx })) throw new ConflictError("Remove this role from its users first");
    await sq.query("DELETE FROM role_permissions WHERE tenant_id=:t AND role_id=:r", { replacements: { t: ctx.tenantId, r: roleId }, transaction: u.tx });
    await u.repo("Role").deleteById(roleId, { transaction: u.tx });
    await u.audit({ action: "role.deleted", entityType: "role", entityId: roleId, before: { key: role.get("key") } });
  });
}

/** Roles held by each user, for the Users page. */
export async function listUserRoles(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "role.read");
  return sq.query<{ userRoleId: string; userId: string; roleId: string; roleKey: string; roleName: string }>(
    `SELECT ur.id AS userRoleId, ur.user_id AS userId, r.id AS roleId, r.\`key\` AS roleKey, r.name AS roleName
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id WHERE ur.tenant_id=:t ORDER BY r.name`,
    { replacements: { t: ctx.tenantId }, type: QueryTypes.SELECT },
  );
}

/** Remove one role from a user. The last tenant administrator cannot be removed, and nobody can strip their own admin role. */
export async function revokeUserRole(sq: Sequelize, ctx: RequestContext, userId: string, userRoleId: string) {
  authorize(ctx, "role.manage");
  return withUow(sq, ctx, async (u) => {
    const ur: any = await u.repo("UserRole").findOne({ where: { id: userRoleId, userId }, transaction: u.tx });
    if (!ur) throw new NotFoundError("Role assignment");
    const role: any = await u.repo("Role").findById(ur.get("roleId"), { transaction: u.tx });
    if (role?.get("key") === "tenant_admin") {
      requireStepUp(ctx);
      if (userId === ctx.userId) throw new ConflictError("You cannot remove your own administrator role");
      const [cnt] = await sq.query<{ c: number }>("SELECT COUNT(*) AS c FROM user_roles WHERE tenant_id=:t AND role_id=:r", { replacements: { t: ctx.tenantId, r: ur.get("roleId") }, transaction: u.tx, type: QueryTypes.SELECT });
      if (Number(cnt?.c) <= 1) throw new ConflictError("A workspace must keep at least one administrator");
    }
    await u.repo("UserRole").deleteById(userRoleId, { transaction: u.tx });
    await u.audit({ action: "user.role_revoked", entityType: "user", entityId: userId, after: { roleKey: role?.get("key") } });
    await u.emit({ type: "user.role_revoked", aggregateType: "user", aggregateId: userId, payload: { roleKey: role?.get("key") } });
  });
}
