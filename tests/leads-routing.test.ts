import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  addLeadActivity, assignLead, changeLeadStage, createContact, createLead, createProject, createRoutingRule, createTask, getLead, ingestLead,
  listLeads, listPipelines, NotFoundError, ruleMatches, updateUser,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { agentIn, makeOrg } from "./brokerage-helpers";

afterAll(closeTestDb);
const sq = () => testDb();
let n = 0;
const phone = () => `05${String(70000000 + ++n * 13 + Math.floor(Math.random() * 9)).padStart(8, "0")}`;
const enquiry = (extra: Record<string, unknown> = {}) => ({ contact: { firstName: uniq("Lead"), phone: phone() }, purpose: "buy" as const, sourceCode: "website", ...extra });

async function setup(agents = 3) {
  const t = await makeTenant();
  const org = await makeOrg(t);
  const team: Awaited<ReturnType<typeof agentIn>>[] = [];
  for (let i = 0; i < agents; i++) team.push(await agentIn(t, org.marina.id, org.bu.id));
  const manager = await agentIn(t, org.marina.id, org.bu.id, "branch_manager");
  return { t, org, team, manager };
}
const assigneeCounts = async (tenantId: string) =>
  Object.fromEntries((await sq().query<{ u: string; n: number }>("SELECT assigned_user_id u, COUNT(*) n FROM leads WHERE tenant_id=:t AND assigned_user_id IS NOT NULL GROUP BY assigned_user_id", { replacements: { t: tenantId }, type: QueryTypes.SELECT })).map((r) => [r.u, Number(r.n)]));

describe("rule matching", () => {
  const lead = { purpose: "buy", projectId: "p1", language: "ar", budgetMin: null, budgetMax: 5_000_000, sourceKind: "portal", sourceCode: "portal_bayut" };
  it("matches every configured condition and fails closed on missing data", () => {
    expect(ruleMatches({}, lead)).toBe(true);
    expect(ruleMatches({ sourceKinds: ["portal"], languages: ["ar"], purposes: ["buy"], minBudget: 3_000_000 }, lead)).toBe(true);
    expect(ruleMatches({ sourceKinds: ["form"] }, lead)).toBe(false);
    expect(ruleMatches({ minBudget: 6_000_000 }, lead)).toBe(false);
    expect(ruleMatches({ maxBudget: 1_000_000 }, lead)).toBe(false);
    expect(ruleMatches({ minBudget: 1 }, { ...lead, budgetMax: null, budgetMin: null })).toBe(false);
    expect(ruleMatches({ projectIds: ["p2"] }, lead)).toBe(false);
    expect(ruleMatches({ languages: ["en"] }, { ...lead, language: null })).toBe(false);
  });
});

describe("lead creation and routing", () => {
  it("creates a lead in the first pipeline stage, routes it, and records history and events", async () => {
    const { t, team } = await setup();
    await createRoutingRule(sq(), t.admin, { name: "default", conditions: {}, target: { userIds: team.map((a) => a.id) } });
    const creator = team[0]!;
    const r = await createLead(sq(), creator.ctx, enquiry({ budgetMax: 2_500_000, language: "en" }));
    expect(r.duplicate).toBe(false);
    expect(team.map((a) => a.id)).toContain(r.assignedUserId);

    const detail = await getLead(sq(), t.admin, r.lead.id);
    expect(detail.status).toBe("open");
    expect(detail.stageEvents).toHaveLength(1);
    expect(detail.assignments[0]).toMatchObject({ method: "rule", assignedUserId: r.assignedUserId });
    const [pipe] = await listPipelines(sq(), t.admin);
    expect(pipe.stages.map((s: any) => s.key)).toEqual(["new", "contacted", "qualified", "viewing", "offer", "won", "lost"]);
    expect(detail.stageId).toBe(pipe.stages[0].id);

    const events = await sq().query<{ type: string }>("SELECT type FROM outbox_events WHERE tenant_id=:t AND aggregate_id=:a", { replacements: { t: t.tenantId, a: r.lead.id }, type: QueryTypes.SELECT });
    expect(events.map((e) => e.type).sort()).toEqual(["lead.assigned", "lead.created"]);
  });

  it("distributes round-robin evenly, including under concurrent inbound leads", async () => {
    const { t, team } = await setup(3);
    await createRoutingRule(sq(), t.admin, { name: "rr", conditions: {}, target: { userIds: team.map((a) => a.id) }, strategy: "round_robin" });
    for (let i = 0; i < 3; i++) await createLead(sq(), t.admin, enquiry());
    expect(Object.values(await assigneeCounts(t.tenantId)).sort()).toEqual([1, 1, 1]);
    await Promise.all(Array.from({ length: 6 }, () => ingestLead(sq(), t.tenantId, enquiry())));
    expect(Object.values(await assigneeCounts(t.tenantId)).sort()).toEqual([3, 3, 3]);
  });

  it("honours rule priority and conditions, and skips disabled users", async () => {
    const { t, org, team } = await setup(3);
    const [vip, a2, a3] = team as [typeof team[0], typeof team[0], typeof team[0]];
    await createRoutingRule(sq(), t.admin, { name: "luxury", priority: 10, conditions: { minBudget: 5_000_000 }, target: { userIds: [vip.id] } });
    await createRoutingRule(sq(), t.admin, { name: "everyone else", priority: 50, conditions: {}, target: { userIds: [a2.id, a3.id] } });
    const big = await createLead(sq(), t.admin, enquiry({ budgetMax: 9_000_000 }));
    expect(big.assignedUserId).toBe(vip.id);
    const small = await createLead(sq(), t.admin, enquiry({ budgetMax: 800_000 }));
    expect([a2.id, a3.id]).toContain(small.assignedUserId);

    await updateUser(sq(), t.admin, vip.id, { status: "disabled" });
    const bigAgain = await createLead(sq(), t.admin, enquiry({ budgetMax: 9_000_000 }));
    expect([a2.id, a3.id]).toContain(bigAgain.assignedUserId); // luxury rule has no eligible agent -> falls through to the next rule
    void org;
  });

  it("enforces per-agent capacity and falls back to unassigned when nobody is eligible", async () => {
    const { t, team } = await setup(2);
    await createRoutingRule(sq(), t.admin, { name: "capped", conditions: {}, target: { userIds: team.map((a) => a.id) }, maxOpenLeads: 1, strategy: "least_loaded" });
    const a = await createLead(sq(), t.admin, enquiry());
    const b = await createLead(sq(), t.admin, enquiry());
    expect(new Set([a.assignedUserId, b.assignedUserId]).size).toBe(2);
    const c = await createLead(sq(), t.admin, enquiry());
    expect(c.assignedUserId).toBeNull();
    const detail = await getLead(sq(), t.admin, c.lead.id);
    expect(detail.assignments[0]).toMatchObject({ method: "fallback", assignedUserId: null });
  });

  it("treats a repeat enquiry for the same person and project as a duplicate, not a new lead", async () => {
    const { t } = await setup(1);
    const project = await createProject(sq(), t.admin, { code: "PALM", name: "Palm" });
    const first = await createLead(sq(), t.admin, enquiry({ contact: { firstName: "Repeat", phone: "0502223333" }, projectId: project.id }));
    const again = await createLead(sq(), t.admin, enquiry({ contact: { firstName: "Repeat R", phone: "+971 50 222 3333" }, projectId: project.id }));
    expect(again.duplicate).toBe(true);
    expect(again.contactReused).toBe(true);
    expect(again.lead.id).toBe(first.lead.id);
    const other = await createLead(sq(), t.admin, enquiry({ contact: { firstName: "Repeat", phone: "0502223333" } })); // different project scope -> new lead
    expect(other.duplicate).toBe(false);
    expect(other.lead.contactId).toBe(first.lead.contactId);
    const detail = await getLead(sq(), t.admin, first.lead.id);
    expect(detail.activities.some((a: any) => a.summary === "Repeat enquiry received")).toBe(true);
  });

  it("ingests trusted inbound leads without a user session and rejects unknown sources", async () => {
    const { t, team } = await setup(1);
    await createRoutingRule(sq(), t.admin, { name: "portal", conditions: { sourceKinds: ["portal"] }, target: { userIds: [team[0]!.id] } });
    const r = await ingestLead(sq(), t.tenantId, enquiry({ sourceCode: "portal_bayut", language: "ar" }));
    expect(r.assignedUserId).toBe(team[0]!.id);
    const nonPortal = await ingestLead(sq(), t.tenantId, enquiry({ sourceCode: "walk_in" }));
    expect(nonPortal.assignedUserId).toBeNull();
    await expect(ingestLead(sq(), t.tenantId, enquiry({ sourceCode: "made_up" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(ingestLead(sq(), t.tenantId, { purpose: "buy" } as any)).rejects.toThrow(/needs a contact/);
  });
});

describe("lead visibility and permissions", () => {
  it("shows agents their own leads, managers their branch, admins everything, and hides other tenants", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const a1 = await agentIn(t, org.marina.id, org.bu.id);
    const a2 = await agentIn(t, org.marina.id, org.bu.id);
    const bayAgent = await agentIn(t, org.bay.id, org.bu.id);
    const mgrMarina = await agentIn(t, org.marina.id, org.bu.id, "branch_manager");
    await createRoutingRule(sq(), t.admin, { name: "a1", priority: 1, conditions: { languages: ["en"] }, target: { userIds: [a1.id] } });
    await createRoutingRule(sq(), t.admin, { name: "a2", priority: 2, conditions: { languages: ["ar"] }, target: { userIds: [a2.id] } });
    await createRoutingRule(sq(), t.admin, { name: "bay", priority: 3, conditions: { languages: ["ru"] }, target: { userIds: [bayAgent.id] } });
    const l1 = await ingestLead(sq(), t.tenantId, enquiry({ language: "en" }));
    const l2 = await ingestLead(sq(), t.tenantId, enquiry({ language: "ar" }));
    const l3 = await ingestLead(sq(), t.tenantId, enquiry({ language: "ru" }));
    const ids = async (ctx: any) => (await listLeads(sq(), ctx, { limit: 100, offset: 0 })).map((l: any) => l.id).sort();

    expect(await ids(await contextFor(t.tenantId, a1.id))).toEqual([l1.lead.id]);
    expect(await ids(mgrMarina.ctx)).toEqual([l1.lead.id, l2.lead.id].sort());
    expect(await ids(t.admin)).toEqual([l1.lead.id, l2.lead.id, l3.lead.id].sort());
    await expect(getLead(sq(), a1.ctx, l2.lead.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLead(sq(), mgrMarina.ctx, l3.lead.id)).rejects.toBeInstanceOf(NotFoundError);

    const other = await makeTenant();
    await expect(getLead(sq(), other.admin, l1.lead.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await ids(other.admin)).toEqual([]);
    const viewer = await makeUser(t, ["viewer"]);
    await expect(listLeads(sq(), viewer.ctx, { limit: 10, offset: 0 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("only lets the assigned agent (or a manager) work a lead, and only managers reassign", async () => {
    const { t, org, team, manager } = await setup(2);
    await createRoutingRule(sq(), t.admin, { name: "one", conditions: {}, target: { userIds: [team[0]!.id] } });
    const l = await createLead(sq(), t.admin, enquiry());
    const owner = await contextFor(t.tenantId, team[0]!.id);
    const stranger = team[1]!.ctx;
    await expect(addLeadActivity(sq(), stranger, l.lead.id, { kind: "note", summary: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await addLeadActivity(sq(), owner, l.lead.id, { kind: "whatsapp", summary: "Sent brochure" });
    const detail = await getLead(sq(), owner, l.lead.id);
    expect(detail.firstResponseAt).toBeTruthy();
    await expect(assignLead(sq(), owner, l.lead.id, { userId: team[1]!.id })).rejects.toBeInstanceOf(ForbiddenError);
    const mgr = await contextFor(t.tenantId, manager.id);
    const moved = await assignLead(sq(), mgr, l.lead.id, { userId: team[1]!.id, reason: "workload" });
    expect(moved.assignedUserId).toBe(team[1]!.id);
    const audit = await sq().query<{ action: string }>("SELECT action FROM audit_events WHERE tenant_id=:t AND entity_id=:e", { replacements: { t: t.tenantId, e: l.lead.id }, type: QueryTypes.SELECT });
    expect(audit.map((a) => a.action)).toContain("lead.reassigned");
    const ownerTask = await createTask(sq(), owner, { title: "Call back", leadId: undefined });
    expect(ownerTask.assigneeId).toBe(team[0]!.id);
    await expect(createTask(sq(), owner, { title: "For someone else", assigneeId: team[1]!.id })).rejects.toBeInstanceOf(ForbiddenError);
    void org;
  });
});

describe("pipeline stages", () => {
  it("requires a loss reason, sets status, keeps explicit history and audits closures", async () => {
    const { t, team, manager } = await setup(1);
    await createRoutingRule(sq(), t.admin, { name: "one", conditions: {}, target: { userIds: [team[0]!.id] } });
    const l = await createLead(sq(), t.admin, enquiry());
    const agent = await contextFor(t.tenantId, team[0]!.id);
    await changeLeadStage(sq(), agent, l.lead.id, { stageKey: "contacted" });
    await changeLeadStage(sq(), agent, l.lead.id, { stageKey: "viewing" });
    await expect(changeLeadStage(sq(), agent, l.lead.id, { stageKey: "lost" })).rejects.toThrow(/loss reason/);
    await expect(changeLeadStage(sq(), agent, l.lead.id, { stageKey: "nonexistent" })).rejects.toBeInstanceOf(NotFoundError);
    const lost = await changeLeadStage(sq(), agent, l.lead.id, { stageKey: "lost", reason: "bought elsewhere" });
    expect(lost).toMatchObject({ status: "lost", lostReason: "bought elsewhere" });

    // Re-opening a closed lead is a manager decision
    await expect(changeLeadStage(sq(), agent, l.lead.id, { stageKey: "qualified" })).rejects.toBeInstanceOf(ForbiddenError);
    const mgr = await contextFor(t.tenantId, manager.id);
    const reopened = await changeLeadStage(sq(), mgr, l.lead.id, { stageKey: "qualified", reason: "customer came back" });
    expect(reopened).toMatchObject({ status: "open", lostReason: null });

    const detail = await getLead(sq(), t.admin, l.lead.id);
    expect(detail.stageEvents).toHaveLength(5); // created, contacted, viewing, lost, qualified
    const audit = await sq().query<{ action: string }>("SELECT action FROM audit_events WHERE tenant_id=:t AND entity_id=:e AND action LIKE 'lead.%'", { replacements: { t: t.tenantId, e: l.lead.id }, type: QueryTypes.SELECT });
    expect(audit.map((a) => a.action)).toContain("lead.lost");
  });
});
