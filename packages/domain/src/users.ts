import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize, Op, WhereOptions } from "sequelize";
import { assertPasswordPolicy, hashPassword, revokeAllSessions, requireStepUp } from "@reales/auth";
import type { RequestContext } from "@reales/database";
import { authorize, can, ForbiddenError, widestScope } from "@reales/rbac";
import { assertQuota, ConflictError, NotFoundError, withUow } from "./uow";

export interface CreateUserInput {
  email: string; firstName?: string; lastName?: string; phoneE164?: string; password?: string;
  roleKeys: string[]; businessUnitId?: string; branchId?: string;
}

const publicUser = (u: any) => ({
  id: u.get("id"), email: u.get("email"), status: u.get("status"),
  businessUnitId: u.get("businessUnitId"), branchId: u.get("branchId"),
  lastLoginAt: u.get("lastLoginAt"), createdAt: u.get("createdAt"),
});

/** Roles that confer tenant-wide administrative power: assigning them needs role.manage AND a fresh second factor. */
const ELEVATED_ROLE_KEYS = new Set(["tenant_admin"]);

export async function createUser(sq: Sequelize, ctx: RequestContext, input: CreateUserInput) {
  authorize(ctx, "user.create");
  if (input.password) assertPasswordPolicy(input.password);
  const email = input.email.trim();
  const hash = input.password ? await hashPassword(input.password) : null;
  return withUow(sq, ctx, async (u) => {
    await assertQuota(u, ctx, "users", "users");
    if (await u.repo("User").findOne({ where: { normalizedEmail: email.toLowerCase() }, transaction: u.tx })) {
      throw new ConflictError("A user with this email already exists");
    }
    // Roles are resolved inside the tenant; unknown role keys are rejected (never created implicitly).
    const roles = await u.repo("Role").findAll({ where: { key: { [Op.in]: input.roleKeys } }, transaction: u.tx });
    if (roles.length !== new Set(input.roleKeys).size) throw new NotFoundError("Role");
    if (roles.some((r: any) => ELEVATED_ROLE_KEYS.has(r.get("key")))) {
      authorize(ctx, "role.manage");
      requireStepUp(ctx);
    }
    const id = randomUUID();
    const user = await u.repo("User").create({
      id, email, normalizedEmail: email.toLowerCase(), passwordHash: hash, status: hash ? "active" : "invited",
      failedLoginCount: 0, businessUnitId: input.businessUnitId ?? null, branchId: input.branchId ?? null,
    }, { transaction: u.tx });
    await u.repo("UserProfile").create({
      userId: id, firstName: input.firstName ?? null, lastName: input.lastName ?? null,
      phoneE164: input.phoneE164 ?? null, locale: "en", timezone: "Asia/Dubai",
    }, { transaction: u.tx });
    for (const r of roles) await u.repo("UserRole").create({ userId: id, roleId: (r as any).get("id") }, { transaction: u.tx });
    await u.audit({ action: "user.created", entityType: "user", entityId: id, after: { email, roles: input.roleKeys } });
    await u.emit({ type: "user.created", aggregateType: "user", aggregateId: id, payload: { email } });
    return publicUser(user);
  });
}

/** Row visibility follows the widest user.read scope: tenant = all, branch = own branches, otherwise nothing. */
export async function listUsers(sq: Sequelize, ctx: RequestContext, opts: { limit: number; offset: number }) {
  const scope = widestScope(ctx, "user.read");
  if (!scope) throw new ForbiddenError("Missing permission: user.read");
  return withUow(sq, ctx, async (u) => {
    let where: WhereOptions = {};
    if (scope === "branch") where = { branchId: { [Op.in]: ctx.membership.branchIds.length ? ctx.membership.branchIds : ["-"] } };
    else if (scope === "business_unit") where = { businessUnitId: { [Op.in]: ctx.membership.businessUnitIds.length ? ctx.membership.businessUnitIds : ["-"] } };
    else if (scope !== "tenant") throw new ForbiddenError("Scope does not permit listing users");
    const rows = await u.repo("User").findAll({ where, limit: opts.limit, offset: opts.offset, order: [["createdAt", "DESC"]], transaction: u.tx });
    return rows.map(publicUser);
  });
}

export interface UpdateUserInput {
  status?: "active" | "disabled";
  businessUnitId?: string | null;
  branchId?: string | null;
  firstName?: string;
  lastName?: string;
}

export async function updateUser(sq: Sequelize, ctx: RequestContext, userId: string, input: UpdateUserInput) {
  return withUow(sq, ctx, async (u) => {
    const user: any = await u.repo("User").findById(userId, { transaction: u.tx });
    if (!user) throw new NotFoundError("User");
    authorize(ctx, "user.update", { branchId: user.get("branchId"), businessUnitId: user.get("businessUnitId"), ownerUserId: userId });
    if (input.status === "disabled" && userId === ctx.userId) throw new ConflictError("You cannot disable your own account");
    const before = { status: user.get("status"), businessUnitId: user.get("businessUnitId"), branchId: user.get("branchId") };
    const { firstName, lastName, ...userFields } = input;
    if (Object.keys(userFields).length) await u.repo("User").updateById(userId, userFields, { transaction: u.tx });
    if (firstName !== undefined || lastName !== undefined) {
      await u.repo("UserProfile").updateWhere({ userId }, { ...(firstName !== undefined && { firstName }), ...(lastName !== undefined && { lastName }) }, { transaction: u.tx });
    }
    await u.audit({ action: "user.updated", entityType: "user", entityId: userId, before, after: input });
    await u.emit({ type: "user.updated", aggregateType: "user", aggregateId: userId, payload: input });
    if (input.status === "disabled") await revokeAllSessions(sq, ctx.tenantId, userId);
    return publicUser(await u.repo("User").findById(userId, { transaction: u.tx }));
  });
}

export async function listRoles(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "role.read");
  return sq.query(
    `SELECT r.id, r.\`key\`, r.name, r.is_system AS isSystem, r.requires_mfa AS requiresMfa,
            GROUP_CONCAT(CONCAT(p.\`key\`, ':', rp.scope) ORDER BY p.\`key\` SEPARATOR ',') AS grants
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE r.tenant_id = :t GROUP BY r.id ORDER BY r.name`,
    { replacements: { t: ctx.tenantId }, type: QueryTypes.SELECT },
  );
}

export async function assignRole(
  sq: Sequelize, ctx: RequestContext, userId: string,
  input: { roleKey: string; anchorType?: "business_unit" | "branch" | "project" | "portfolio"; anchorId?: string },
) {
  authorize(ctx, "role.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("User").findById(userId, { transaction: u.tx }))) throw new NotFoundError("User");
    const role: any = await u.repo("Role").findOne({ where: { key: input.roleKey }, transaction: u.tx });
    if (!role) throw new NotFoundError("Role");
    if (ELEVATED_ROLE_KEYS.has(input.roleKey)) requireStepUp(ctx);
    // Privilege-escalation guard: you can only grant a role whose permissions you already hold at tenant scope.
    const granted: any[] = await sq.query(
      "SELECT p.`key` AS perm FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.tenant_id=:t AND rp.role_id=:r",
      { replacements: { t: ctx.tenantId, r: role.get("id") }, transaction: u.tx, type: QueryTypes.SELECT },
    );
    const missing = granted.filter((g) => !can(ctx, g.perm)).map((g) => g.perm);
    if (missing.length) throw new ForbiddenError(`Cannot grant a role containing permissions you do not hold: ${missing.slice(0, 3).join(", ")}`);
    await u.repo("UserRole").create({ userId, roleId: role.get("id"), anchorType: input.anchorType ?? null, anchorId: input.anchorId ?? null }, { transaction: u.tx });
    await u.audit({ action: "user.role_assigned", entityType: "user", entityId: userId, after: input });
    await u.emit({ type: "user.role_assigned", aggregateType: "user", aggregateId: userId, payload: input });
  });
}
