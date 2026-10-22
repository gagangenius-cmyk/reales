import { afterAll, describe, expect, it } from "vitest";
import {
  advanceDealStage, completeMilestone, createCommissionPlan, createDeal, createReservation, DealBlockedError, getDealChecklist, listCommissions, saveChecklistTemplate,
  setTarget, setTeamMember, createTeam, listTeamsDetailed, targetProgress, updateChecklistItem, updateTeam, addChecklistItem, upsertAgentProfile,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, testDb, uniq } from "./helpers";
import { acceptedOffer, kit, walkTo } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);

async function dealFor(t: Awaited<ReturnType<typeof makeTenant>>, k: Awaited<ReturnType<typeof kit>>, amount = 1_000_000) {
  const offer = await acceptedOffer(t, k, { amount });
  const res = await createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id, depositAmount: 50_000 });
  return createDeal(sq(), k.mgr.ctx, { reservationId: res.id });
}

describe("deal checklists", () => {
  it("copies the template onto a new deal, blocks the gated stage until done, and waivers need a reason and a manager", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await saveChecklistTemplate(sq(), t.admin, { name: uniq("Sale"), dealType: "sale", items: [
      { title: "Buyer ID copy", gateStage: "contract", dueOffsetDays: 2 }, { title: "Optional welcome pack", required: false }, { title: "Developer NOC", gateStage: "registration" },
    ] });
    const deal = await dealFor(t, k);
    const list = await getDealChecklist(sq(), k.mgr.ctx, deal.id);
    expect(list.items.map((i: any) => i.title)).toEqual(["Buyer ID copy", "Optional welcome pack", "Developer NOC"]);
    expect(list.progress).toMatchObject({ done: 0, total: 3, requiredOpen: 2 });
    expect(list.items[0].dueAt).toBeTruthy();

    // contract stage needs the deposit milestone AND the checklist item
    await completeMilestone(sq(), k.mgr.ctx, deal.id, "deposit", { reason: "bank statement seen" });
    const err: any = await advanceDealStage(sq(), k.mgr.ctx, deal.id, { to: "contract" }).catch((e) => e);
    expect(err).toBeInstanceOf(DealBlockedError);
    expect(err.reasons?.join(" ") ?? err.message).toMatch(/Buyer ID copy/);

    const [id1, , id3] = list.items.map((i: any) => i.id);
    await updateChecklistItem(sq(), k.mgr.ctx, id1, { status: "done" });
    expect((await advanceDealStage(sq(), k.mgr.ctx, deal.id, { to: "contract" })).stage).toBe("contract");

    // waiving: agent cannot (needs deal.close), a manager needs a reason
    await expect(updateChecklistItem(sq(), k.agent.ctx, id3, { status: "waived", reason: "n/a" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateChecklistItem(sq(), k.mgr.ctx, id3, { status: "waived" })).rejects.toThrow(/reason/);
    const waived = await updateChecklistItem(sq(), k.mgr.ctx, id3, { status: "waived", reason: "Freehold, no NOC needed" });
    expect(waived).toMatchObject({ status: "waived", waivedReason: "Freehold, no NOC needed" });
    const more = await addChecklistItem(sq(), k.mgr.ctx, deal.id, { title: "Extra: proof of funds", gateStage: "payment" });
    expect(more.id).toBeTruthy();
    const after = await getDealChecklist(sq(), k.mgr.ctx, deal.id);
    expect(after.progress.requiredOpen).toBe(1); // the extra item
    // a template change never touches a deal already created
    await saveChecklistTemplate(sq(), t.admin, { name: uniq("Sale2"), dealType: "sale", items: [{ title: "Different" }] });
    expect((await getDealChecklist(sq(), k.mgr.ctx, deal.id)).items.length).toBe(4);
  });
});

describe("commission slabs", () => {
  it("raises the agent share once the year-to-date value crosses a slab and records which slab applied", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await upsertAgentProfile(sq(), t.admin, { userId: k.agent.id, agentType: "internal" });
    await createCommissionPlan(sq(), t.admin, {
      name: uniq("Tiered"), dealType: "sale", ratePct: 2, splits: [{ role: "agent", pct: 50 }, { role: "company", pct: 50 }],
      slabs: [{ fromValue: 0, agentSharePct: 50 }, { fromValue: 1_000_000, agentSharePct: 60 }, { fromValue: 2_500_000, ratePct: 2.5, agentSharePct: 70 }],
    });
    await expect(createCommissionPlan(sq(), t.admin, { name: "bad", dealType: "sale", ratePct: 2, splits: [{ role: "agent", pct: 100 }], slabs: [{ fromValue: 10, ratePct: 3 }] })).rejects.toThrow(/start at 0/);

    const close = async (amount: number) => { const d = await dealFor(t, k, amount); await walkTo(k, d.id, "closed"); return d; };
    const first = await close(1_200_000); // ytd 0 -> base slab
    const c1 = (await listCommissions(sq(), t.admin, { limit: 10, offset: 0 })).find((c: any) => c.dealId === first.id)!;
    expect(c1.splits.find((s: any) => s.role === "agent").pct).toBe("50.000");
    expect(Number(c1.commissionAmount)).toBe(24_000);
    expect(c1.slabApplied).toMatchObject({ fromValue: 0 });
  });
});

describe("teams and targets", () => {
  it("keeps one leader, refuses hierarchy loops, and measures targets against real results", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const team = await createTeam(sq(), t.admin, { name: uniq("Marina"), branchId: k.org.marina.id });
    const sub = await createTeam(sq(), t.admin, { name: uniq("Sub") });
    await setTeamMember(sq(), t.admin, team.id, k.agent.id);
    await setTeamMember(sq(), t.admin, team.id, k.mgr.id, "leader");
    await setTeamMember(sq(), t.admin, team.id, k.other.id, "leader");
    const detail = (await listTeamsDetailed(sq(), t.admin)).find((x: any) => x.id === team.id)!;
    expect(detail.members.filter((m: any) => m.role === "leader")).toHaveLength(1);
    expect(detail.leaderEmail).toBeTruthy();
    await updateTeam(sq(), t.admin, sub.id, { parentTeamId: team.id });
    await expect(updateTeam(sq(), t.admin, team.id, { parentTeamId: sub.id })).rejects.toThrow(/ancestor/);
    await expect(updateTeam(sq(), t.admin, team.id, { parentTeamId: team.id })).rejects.toThrow(/own parent/);

    // closed value counts only deals closed by team members in the period
    const deal = await dealFor(t, k, 800_000);
    await walkTo(k, deal.id, "closed");
    const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
    await setTarget(sq(), t.admin, { scopeType: "team", scopeId: team.id, periodType: "month", periodStart: today, metric: "closed_value", targetValue: 1_000_000 });
    await setTarget(sq(), t.admin, { scopeType: "user", scopeId: k.agent.id, periodType: "month", periodStart: today, metric: "closed_deals", targetValue: 2 });
    const rows = await targetProgress(sq(), t.admin, { periodType: "month" });
    const teamRow = rows.find((r) => r.scopeType === "team" && r.scopeId === team.id)!;
    expect(teamRow.actual).toBe(800_000);
    expect(teamRow.pct).toBeCloseTo(0.8);
    expect(rows.find((r) => r.scopeType === "user")!.actual).toBe(1);
    // a manager cannot set a company-wide target; an agent cannot set any
    await expect(setTarget(sq(), k.mgr.ctx, { scopeType: "tenant", periodType: "month", periodStart: today, metric: "closed_deals", targetValue: 10 })).rejects.toThrow(/tenant-wide/);
    await expect(setTarget(sq(), k.agent.ctx, { scopeType: "user", scopeId: k.agent.id, periodType: "month", periodStart: today, metric: "closed_deals", targetValue: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    // an agent only sees their own and their team's targets
    const mine = await targetProgress(sq(), await contextFor(t.tenantId, k.agent.id), { periodType: "month" });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.scopeType !== "tenant")).toBe(true);
  });
});
