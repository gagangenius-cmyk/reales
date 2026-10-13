import { afterAll, describe, expect, it } from "vitest";
import { authorize, can, ForbiddenError, hasPermission, widestScope } from "@reales/rbac";
import { assignRole, createBranch, createBusinessUnit, createProject, createUser, listUsers, QuotaExceededError, updateProject } from "@reales/domain";
import { initModels, repo } from "@reales/database";
import { closeTestDb, contextFor, makeTenant, makeUser, PASSWORD, testDb, uniq } from "./helpers";

afterAll(closeTestDb);

describe("RBAC scopes", () => {
  it("evaluates own_records, branch and project scopes against the resource", async () => {
    const t = await makeTenant();
    const bu = await createBusinessUnit(testDb(), t.admin, { name: "BU", type: "brokerage" });
    const marina = await createBranch(testDb(), t.admin, { businessUnitId: bu.id, name: "Marina" });
    const bay = await createBranch(testDb(), t.admin, { businessUnitId: bu.id, name: "Business Bay" });
    const broker = await makeUser(t, ["senior_broker"], { branchId: marina.id, businessUnitId: bu.id });
    const c = broker.ctx;

    expect(can(c, "lead.read", { branchId: marina.id })).toBe(true);
    expect(can(c, "lead.read", { branchId: bay.id })).toBe(false);
    expect(can(c, "lead.update", { ownerUserId: broker.id })).toBe(true);
    expect(can(c, "lead.update", { ownerUserId: "someone-else" })).toBe(false);
    expect(can(c, "lead.update")).toBe(false); // resource-less check only passes tenant-wide grants
    expect(can(c, "audit.read")).toBe(false);
    expect(hasPermission(c, "lead.read")).toBe(true);
    expect(widestScope(c, "lead.read")).toBe("branch");
    expect(() => authorize(c, "tenant.manage")).toThrow(ForbiddenError);
  });

  it("restricts listing.publish to the anchored project (project:A)", async () => {
    const t = await makeTenant();
    const a = await createProject(testDb(), t.admin, { code: "A", name: "Project A" });
    const b = await createProject(testDb(), t.admin, { code: "B", name: "Project B" });
    const broker = await makeUser(t, ["senior_broker"]);
    await assignRole(testDb(), t.admin, broker.id, { roleKey: "senior_broker", anchorType: "project", anchorId: a.id });
    const ctx = await contextFor(t.tenantId, broker.id);
    expect(can(ctx, "listing.publish", { projectId: a.id })).toBe(true);
    expect(can(ctx, "listing.publish", { projectId: b.id })).toBe(false);
  });
});

describe("privilege escalation guards", () => {
  it("a branch manager cannot create users or grant roles", async () => {
    const t = await makeTenant();
    const mgr = await makeUser(t, ["branch_manager"]);
    await expect(createUser(testDb(), mgr.ctx, { email: `${uniq()}@x.test`, roleKeys: ["viewer"] })).rejects.toBeInstanceOf(ForbiddenError);
    const target = await makeUser(t, ["viewer"]);
    await expect(assignRole(testDb(), mgr.ctx, target.id, { roleKey: "tenant_admin" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creating or assigning tenant_admin requires a fresh step-up", async () => {
    const t = await makeTenant();
    const noStepUp = await contextFor(t.tenantId, t.adminId, { stepUp: false });
    await expect(createUser(testDb(), noStepUp, { email: `${uniq()}@x.test`, roleKeys: ["tenant_admin"], password: PASSWORD })).rejects.toMatchObject({ code: "step_up_required" });
    const target = await makeUser(t, ["viewer"]);
    await expect(assignRole(testDb(), noStepUp, target.id, { roleKey: "tenant_admin" })).rejects.toMatchObject({ code: "step_up_required" });
    await expect(assignRole(testDb(), t.admin, target.id, { roleKey: "tenant_admin" })).resolves.toBeUndefined();
  });

  it("cannot grant a role holding permissions the granter lacks", async () => {
    const t = await makeTenant();
    // A delegate who may manage roles but does not hold audit.read
    const m = initModels(testDb());
    const delegate = await makeUser(t, ["viewer"]);
    const roleId = (await repo(m.Role, t.admin).create({ key: "role_admin_only", name: "Role admin", isSystem: false, requiresMfa: false }) as any).get("id");
    const [perm]: any[] = await testDb().query("SELECT id FROM permissions WHERE `key`='role.manage'", { type: "SELECT" as never });
    await repo(m.RolePermission, t.admin).create({ roleId, permissionId: perm.id, scope: "tenant" });
    await repo(m.UserRole, t.admin).create({ userId: delegate.id, roleId });
    const ctx = await contextFor(t.tenantId, delegate.id);
    const target = await makeUser(t, ["viewer"]);
    await expect(assignRole(testDb(), ctx, target.id, { roleKey: "compliance_officer" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("quotas and validation", () => {
  it("enforces the plan user quota", async () => {
    const t = await makeTenant();
    await testDb().query("UPDATE tenant_quotas SET limit_value = 2 WHERE tenant_id = :t AND quota_key = 'users'", { replacements: { t: t.tenantId } });
    await makeUser(t, ["viewer"]); // 2nd user (admin is the 1st)
    await expect(createUser(testDb(), t.admin, { email: `${uniq()}@x.test`, roleKeys: ["viewer"], password: PASSWORD })).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("rejects weak passwords and duplicate project codes", async () => {
    const t = await makeTenant();
    await expect(createUser(testDb(), t.admin, { email: `${uniq()}@x.test`, roleKeys: ["viewer"], password: "short" })).rejects.toThrow(/at least 12/);
    await createProject(testDb(), t.admin, { code: "DUP", name: "one" });
    await expect(createProject(testDb(), t.admin, { code: "DUP", name: "two" })).rejects.toMatchObject({ status: 409 });
    const viewer = await makeUser(t, ["viewer"]);
    await expect(updateProject(testDb(), viewer.ctx, (await createProject(testDb(), t.admin, { code: "P9", name: "n" })).id, { name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listUsers(testDb(), viewer.ctx, { limit: 10, offset: 0 })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
