import { randomUUID } from "node:crypto";
import { Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize, ForbiddenError, widestScope } from "@reales/rbac";
import { plain } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

/** Teams with their leader, parent, members and branch, for the Organisation screen. */
export async function listTeamsDetailed(sq: Sequelize, ctx: RequestContext) {
  if (!widestScope(ctx, "org.read")) throw new ForbiddenError("Missing permission: org.read");
  return withUow(sq, ctx, async (u) => {
    const [teams, members, users, branches] = await Promise.all([
      u.repo("Team").findAll({ order: [["name", "ASC"]], transaction: u.tx }), u.repo("TeamMember").findAll({ transaction: u.tx }),
      u.repo("User").findAll({ transaction: u.tx }), u.repo("Branch").findAll({ transaction: u.tx }),
    ]);
    const email = new Map((users as any[]).map((x) => [x.get("id"), x.get("email") as string]));
    const branch = new Map((branches as any[]).map((b) => [b.get("id"), b.get("name") as string]));
    return (teams as any[]).map((t) => ({
      ...plain(t), branchName: branch.get(t.get("branchId")) ?? null, leaderEmail: email.get(t.get("leaderUserId")) ?? null,
      members: (members as any[]).filter((m) => m.get("teamId") === t.get("id")).map((m) => ({ id: m.get("id"), userId: m.get("userId"), email: email.get(m.get("userId")) ?? "User", role: m.get("role") })),
    }));
  });
}

export async function updateTeam(sq: Sequelize, ctx: RequestContext, id: string, i: { name?: string; branchId?: string | null; parentTeamId?: string | null; description?: string | null; status?: "active" | "archived" }) {
  authorize(ctx, "org.manage");
  return withUow(sq, ctx, async (u) => {
    const t: any = await u.repo("Team").findById(id, { transaction: u.tx });
    if (!t) throw new NotFoundError("Team");
    if (i.parentTeamId) {
      if (i.parentTeamId === id) throw new ConflictError("A team cannot be its own parent");
      let cur: any = await u.repo("Team").findById(i.parentTeamId, { transaction: u.tx });
      if (!cur) throw new NotFoundError("Parent team");
      for (let depth = 0; cur && depth < 20; depth++) { // refuse loops: the new parent must not sit below this team
        if (cur.get("parentTeamId") === id) throw new ConflictError("That would make the team its own ancestor");
        cur = cur.get("parentTeamId") ? await u.repo("Team").findById(cur.get("parentTeamId"), { transaction: u.tx }) : null;
      }
    }
    if (i.branchId && !(await u.repo("Branch").findById(i.branchId, { transaction: u.tx }))) throw new NotFoundError("Branch");
    const patch: Record<string, unknown> = {};
    if (i.name !== undefined) { if (!i.name.trim()) throw new ConflictError("A team needs a name"); patch.name = i.name.trim(); }
    for (const k of ["branchId", "parentTeamId", "description", "status"] as const) if (i[k] !== undefined) patch[k] = i[k];
    await u.repo("Team").updateById(id, patch, { transaction: u.tx });
    await u.audit({ action: "team.updated", entityType: "team", entityId: id, before: { name: t.get("name"), status: t.get("status") }, after: i });
    return plain(await u.repo("Team").findById(id, { transaction: u.tx }));
  });
}

/** Add or change a member. Setting role "leader" makes that person the team leader and demotes the previous one. */
export async function setTeamMember(sq: Sequelize, ctx: RequestContext, teamId: string, userId: string, role: "leader" | "member" = "member") {
  authorize(ctx, "org.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Team").findById(teamId, { transaction: u.tx }))) throw new NotFoundError("Team");
    const user: any = await u.repo("User").findOne({ where: { id: userId, status: "active" }, transaction: u.tx });
    if (!user) throw new NotFoundError("User");
    const today = new Date().toISOString().slice(0, 10);
    const existing: any = await u.repo("TeamMember").findOne({ where: { teamId, userId }, transaction: u.tx });
    if (role === "leader") await u.repo("TeamMember").updateWhere({ teamId, role: "leader" }, { role: "member" }, { transaction: u.tx });
    if (existing) await u.repo("TeamMember").updateById(existing.get("id"), { role }, { transaction: u.tx });
    else await u.repo("TeamMember").create({ id: randomUUID(), teamId, userId, role, joinedOn: today }, { transaction: u.tx });
    if (role === "leader") await u.repo("Team").updateById(teamId, { leaderUserId: userId }, { transaction: u.tx });
    else {
      const team: any = await u.repo("Team").findById(teamId, { transaction: u.tx });
      if (team.get("leaderUserId") === userId) await u.repo("Team").updateById(teamId, { leaderUserId: null }, { transaction: u.tx });
    }
    await u.audit({ action: "team.member_set", entityType: "team", entityId: teamId, after: { userId, role } });
  });
}

export async function removeTeamMember(sq: Sequelize, ctx: RequestContext, teamId: string, userId: string) {
  authorize(ctx, "org.manage");
  return withUow(sq, ctx, async (u) => {
    const m: any = await u.repo("TeamMember").findOne({ where: { teamId, userId }, transaction: u.tx });
    if (!m) throw new NotFoundError("Team member");
    await u.repo("TeamMember").deleteById(m.get("id"), { transaction: u.tx });
    const team: any = await u.repo("Team").findById(teamId, { transaction: u.tx });
    if (team?.get("leaderUserId") === userId) await u.repo("Team").updateById(teamId, { leaderUserId: null }, { transaction: u.tx });
    await u.audit({ action: "team.member_removed", entityType: "team", entityId: teamId, after: { userId } });
  });
}
