import { afterAll, describe, expect, it } from "vitest";
import { initModels, repo, TenantViolationError } from "@reales/database";
import { createProject, listProjects, updateProject, createBranch, createBusinessUnit, addTeamMember, createTeam, updateUser, assignRole, listUsers, NotFoundError } from "@reales/domain";
import { closeTestDb, makeTenant, testDb, makeUser } from "../helpers";

afterAll(closeTestDb);

describe("tenant isolation: repository layer", () => {
  it("never returns, updates or deletes another tenant's rows, even with a known id", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const p = await createProject(testDb(), a.admin, { code: "ALPHA", name: "Alpha" });
    const m = initModels(testDb());

    const bRepo = repo(m.Project, b.admin);
    expect(await bRepo.findById(p.id)).toBeNull();
    expect(await bRepo.findAll()).toHaveLength(0);
    expect(await bRepo.count()).toBe(0);
    expect(await bRepo.updateById(p.id, { name: "hijacked" })).toBe(0);
    expect(await bRepo.deleteById(p.id)).toBe(0);
    expect(await bRepo.updateWhere({ code: "ALPHA" }, { name: "hijacked" })).toBe(0);
    expect(await bRepo.deleteWhere({ code: "ALPHA" })).toBe(0);

    const stillThere = await repo(m.Project, a.admin).findById(p.id);
    expect((stillThere as any).get("name")).toBe("Alpha");
  });

  it("rejects a caller-supplied foreign tenantId on create and update, and stamps the real one", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const m = initModels(testDb());
    const aRepo = repo(m.Project, a.admin);
    await expect(aRepo.create({ tenantId: b.tenantId, code: "X1", name: "x", kind: "project", status: "active" })).rejects.toBeInstanceOf(TenantViolationError);
    const row: any = await aRepo.create({ code: "X2", name: "x", kind: "project", status: "active" });
    expect(row.get("tenantId")).toBe(a.tenantId);
    await expect(aRepo.updateById(row.get("id"), { tenantId: b.tenantId })).rejects.toBeInstanceOf(TenantViolationError);
    expect(() => repo(m.Project, { tenantId: "" })).toThrow(TenantViolationError);
  });

  it("scopes list queries to the caller's tenant", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await createProject(testDb(), a.admin, { code: "P1", name: "A-one" });
    await createProject(testDb(), b.admin, { code: "P1", name: "B-one" }); // same code allowed across tenants
    const listA = await listProjects(testDb(), a.admin);
    const listB = await listProjects(testDb(), b.admin);
    expect(listA.map((p: any) => p.name)).toEqual(["A-one"]);
    expect(listB.map((p: any) => p.name)).toEqual(["B-one"]);
  });
});

describe("tenant isolation: domain services treat foreign ids as not found", () => {
  it("cannot mutate or attach to another tenant's resources", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const proj = await createProject(testDb(), a.admin, { code: "SECRET", name: "Secret" });
    const bu = await createBusinessUnit(testDb(), a.admin, { name: "A brokerage", type: "brokerage" });
    const team = await createTeam(testDb(), a.admin, { name: "A team" });
    const aUser = await makeUser(a, ["viewer"]);

    await expect(updateProject(testDb(), b.admin, proj.id, { name: "pwn" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createBranch(testDb(), b.admin, { businessUnitId: bu.id, name: "sneaky" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addTeamMember(testDb(), b.admin, team.id, aUser.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateUser(testDb(), b.admin, aUser.id, { status: "disabled" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignRole(testDb(), b.admin, aUser.id, { roleKey: "viewer" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createProject(testDb(), b.admin, { code: "OK", name: "ok", businessUnitId: bu.id })).rejects.toBeInstanceOf(NotFoundError);

    const bUsers = await listUsers(testDb(), b.admin, { limit: 100, offset: 0 });
    expect(bUsers.every((u: any) => u.id !== aUser.id)).toBe(true);
  });
});
