import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  callStats, claimLead, createLead, createRoutingRule, getLead, listCalls, listMyNotifications, listPools, logCall, poolLeads, releaseToPool, repoolSweep, saveRepoolRule, savePool,
} from "@reales/domain";
import { systemContext } from "@reales/database";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, testDb, uniq } from "./helpers";
import { kit, phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const later = (min: number) => new Date(Date.now() + min * 60_000);
const newLead = (ctx: any, assignedUserId: string, extra: Record<string, unknown> = {}) =>
  createLead(sq(), ctx, { contact: { firstName: uniq("L"), phone: phone() }, purpose: "buy", sourceCode: "walk_in", assignedUserId, ...extra } as any);

describe("lead pools", () => {
  it("lets one agent win a claim, enforces the daily limit, and lets owners and managers release leads", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const pool = await savePool(sq(), t.admin, { name: uniq("Portal pool"), dailyClaimLimit: 1 });
    await expect(savePool(sq(), k.agent.ctx, { name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    const a = await newLead(t.admin, k.mgr.id), b = await newLead(t.admin, k.mgr.id);
    await releaseToPool(sq(), t.admin, a.lead.id, pool.id, "Needs a fresh owner");
    await releaseToPool(sq(), t.admin, b.lead.id, pool.id, "Needs a fresh owner");
    await expect(releaseToPool(sq(), t.admin, a.lead.id, pool.id, " ")).rejects.toThrow(/reason/);
    expect((await listPools(sq(), k.agent.ctx))[0].waiting).toBe(2);
    expect((await poolLeads(sq(), k.agent.ctx, pool.id)).length).toBe(2);

    // two agents race for the same lead: exactly one wins
    const results = await Promise.allSettled([claimLead(sq(), k.agent.ctx, a.lead.id), claimLead(sq(), k.other.ctx, a.lead.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>;
    expect((await getLead(sq(), t.admin, a.lead.id)).assignedUserId).toBe(winner.value.assignedUserId);
    expect((await getLead(sq(), t.admin, a.lead.id)).poolId).toBeNull();

    // the winner has used today's single claim; the other agent can still claim the second lead
    const winnerCtx = winner.value.assignedUserId === k.agent.id ? k.agent.ctx : k.other.ctx;
    const otherCtx = winnerCtx === k.agent.ctx ? k.other.ctx : k.agent.ctx;
    await expect(claimLead(sq(), winnerCtx, b.lead.id)).rejects.toThrow(/limit/);
    expect((await claimLead(sq(), otherCtx, b.lead.id)).assignedUserId).toBeTruthy();
    // an owner can hand their own lead back; a stranger cannot
    const mine = await newLead(t.admin, k.agent.id);
    await expect(releaseToPool(sq(), k.other.ctx, mine.lead.id, pool.id, "not mine")).rejects.toThrow();
    expect((await releaseToPool(sq(), k.agent.ctx, mine.lead.id, pool.id, "On leave")).poolId).toBe(pool.id);
  });
});

describe("repool sweep", () => {
  it("takes stale leads back on the assignment clock, respects limits, and is idempotent", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const sys = systemContext(t.tenantId, uniq("corr"));
    const pool = await savePool(sq(), t.admin, { name: uniq("Pool") });
    await createRoutingRule(sq(), t.admin, { name: "other only", priority: 1, conditions: {}, target: { userIds: [k.other.id] }, strategy: "round_robin" });
    await saveRepoolRule(sq(), t.admin, { name: "30 min no answer", triggerKind: "no_first_response", afterMinutes: 30, action: "reassign", poolId: pool.id, maxRepools: 2 });
    await expect(saveRepoolRule(sq(), t.admin, { name: "bad", triggerKind: "no_activity", afterMinutes: 1, action: "to_pool", poolId: pool.id })).rejects.toThrow(/5 minutes/);

    const fresh = await newLead(t.admin, k.agent.id);
    // not yet due: just assigned
    expect(await repoolSweep(sq(), sys, later(10))).toEqual({ reassigned: 0, pooled: 0, alerted: 0 });
    // due: handed to the next eligible agent, notifications go out, history is recorded
    expect(await repoolSweep(sq(), sys, later(45))).toMatchObject({ reassigned: 1 });
    let lead = await getLead(sq(), t.admin, fresh.lead.id);
    expect(lead.assignedUserId).toBe(k.other.id);
    expect(lead.repoolCount).toBe(1);
    expect(lead.assignments.some((a: any) => a.method === "rule" && /repool/.test(a.reason))).toBe(true);
    expect((await listMyNotifications(sq(), k.agent.ctx)).some((n: any) => n.kind === "lead.repooled")).toBe(true);
    // idempotent: the clock restarted with the new assignment
    expect(await repoolSweep(sq(), sys, later(46))).toEqual({ reassigned: 0, pooled: 0, alerted: 0 });
    // the only eligible agent already holds it, so the rule falls back to the pool
    expect(await repoolSweep(sq(), sys, later(120))).toMatchObject({ pooled: 1 });
    lead = await getLead(sq(), t.admin, fresh.lead.id);
    expect(lead.assignedUserId).toBeNull();
    expect(lead.poolId).toBe(pool.id);
    expect(lead.repoolCount).toBe(2);
    // a lead that got its first response is left alone
    const answered = await newLead(t.admin, k.agent.id);
    await logCall(sq(), k.agent.ctx, { leadId: answered.lead.id, outcome: "answered", durationSec: 60 });
    expect(await repoolSweep(sq(), sys, later(300))).toEqual({ reassigned: 0, pooled: 0, alerted: 0 });
  });

  it("can alert managers instead of moving the lead, once per stale period", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const sys = systemContext(t.tenantId, uniq("corr"));
    await saveRepoolRule(sq(), t.admin, { name: "alert", triggerKind: "no_activity", afterMinutes: 60, action: "notify_manager", hotOnly: true });
    const hot = await newLead(t.admin, k.agent.id, { isHot: true });
    const cold = await newLead(t.admin, k.agent.id);
    const r1 = await repoolSweep(sq(), sys, later(90));
    expect(r1.alerted).toBeGreaterThan(0);
    expect((await repoolSweep(sq(), sys, later(91))).alerted).toBe(0); // deduped
    const [row] = await sq().query<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE tenant_id=:t AND kind='lead.stale' AND entity_id=:id", { replacements: { t: t.tenantId, id: cold.lead.id }, type: QueryTypes.SELECT });
    expect(Number(row!.n)).toBe(0); // hot_only: the cold lead is ignored
    expect((await getLead(sq(), t.admin, hot.lead.id)).assignedUserId).toBe(k.agent.id); // not moved
  });
});

describe("call log", () => {
  it("records the call everywhere it matters and reports per-agent statistics with scope", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const lead = await newLead(t.admin, k.agent.id);
    await expect(logCall(sq(), k.agent.ctx, { leadId: lead.lead.id, outcome: "answered" })).rejects.toThrow(/duration/);
    await expect(logCall(sq(), k.agent.ctx, { leadId: lead.lead.id, outcome: "no_answer", startedAt: later(60).toISOString() })).rejects.toThrow(/future/);
    const call = await logCall(sq(), k.agent.ctx, { leadId: lead.lead.id, outcome: "callback_requested", durationSec: 45, notes: "Call back after 6pm" });
    expect(call.followUpAt).toBeTruthy(); // defaulted for a requested callback
    const after = await getLead(sq(), t.admin, lead.lead.id);
    expect(after.lastContactedAt).toBeTruthy();
    expect(after.firstResponseAt).toBeTruthy();
    expect(after.nextFollowUpAt).toBeTruthy();
    expect(after.activities.some((a: any) => a.kind === "call" && /callback requested/.test(a.summary))).toBe(true);
    await logCall(sq(), k.agent.ctx, { leadId: lead.lead.id, outcome: "answered", durationSec: 120 });
    await logCall(sq(), k.other.ctx, { contactId: k.contact.id, outcome: "no_answer", direction: "inbound" });
    // an agent cannot log a call against a lead they cannot see
    await expect(logCall(sq(), k.other.ctx, { leadId: lead.lead.id, outcome: "no_answer" })).rejects.toThrow();

    const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
    const all = await callStats(sq(), t.admin, { from: today, to: today });
    expect(all.total.calls).toBe(3);
    const me = all.agents.find((a) => a.userId === k.agent.id)!;
    expect(me).toMatchObject({ calls: 2, answered: 1, callbacks: 1, talkMinutes: 3 });
    expect(me.answerRate).toBeCloseTo(0.5);
    // agents see only their own calls
    const mineOnly = await listCalls(sq(), await contextFor(t.tenantId, k.agent.id), { limit: 50, offset: 0 });
    expect(mineOnly.every((c: any) => c.userId === k.agent.id)).toBe(true);
    expect((await callStats(sq(), k.agent.ctx, { from: today, to: today })).agents.map((a) => a.userId)).toEqual([k.agent.id]);
    // a branch manager sees their branch
    expect((await listCalls(sq(), k.mgr.ctx, { limit: 50, offset: 0 })).length).toBe(3);
    void createRoutingRule;
  });
});
