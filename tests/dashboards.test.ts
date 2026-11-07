import { afterAll, describe, expect, it } from "vitest";
import { agentDashboard, createLead, teamDashboard } from "@reales/domain";
import { closeTestDb, makeTenant, testDb, uniq } from "./helpers";
import { agentIn, makeOrg } from "./brokerage-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const kpi = (d: { kpis: { key: string; value: number }[] }, key: string) => d.kpis.find((k) => k.key === key)?.value;

describe("dashboards", () => {
  it("shows an agent only their own leads, and a branch manager only their branch", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const a1 = await agentIn(t, org.marina.id, org.bu.id), a2 = await agentIn(t, org.marina.id, org.bu.id), far = await agentIn(t, org.bay.id, org.bu.id);
    const mgr = await agentIn(t, org.marina.id, org.bu.id, "branch_manager");
    const mk = (who: typeof a1, hot = false) => createLead(sq(), t.admin, { contact: { firstName: uniq("C"), phone: `05${String(50000000 + Math.floor(Math.random() * 9999999))}` }, purpose: "buy", assignedUserId: who.id, isHot: hot } as never);
    await mk(a1, true); await mk(a1); await mk(a2); await mk(far);

    const mine = await agentDashboard(sq(), a1.ctx);
    expect(kpi(mine, "open")).toBe(2);
    expect(kpi(mine, "hot")).toBe(1);
    expect((await agentDashboard(sq(), a2.ctx)).kpis.find((k) => k.key === "open")?.value).toBe(1);

    const team = await teamDashboard(sq(), mgr.ctx);
    expect(kpi(team, "open")).toBeGreaterThanOrEqual(3); // Marina branch leads only
    expect(team.workload.map((w) => w.agent).join(",")).not.toContain(far.email);
    const all = await teamDashboard(sq(), t.admin);
    expect(kpi(all, "open")).toBe(4);
  });
});
