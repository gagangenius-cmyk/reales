import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { createLead, setSettings, transferLeads } from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, testDb, uniq } from "./helpers";
import { agentIn, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const lead = (ctx: any, agentId: string, extra: Record<string, unknown> = {}) => createLead(sq(), ctx, { contact: { firstName: uniq("L"), phone: phone() }, purpose: "buy", sourceCode: "walk_in", assignedUserId: agentId, ...extra } as never);

describe("lead transfer", () => {
  it("previews, then moves open leads to the new owner with a reason, and leaves other people's leads alone", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const from = await agentIn(t, org.marina.id, org.bu.id), to = await agentIn(t, org.marina.id, org.bu.id), bystander = await agentIn(t, org.marina.id, org.bu.id);
    const a: any = await lead(t.admin, from.id), b: any = await lead(t.admin, from.id, { isHot: true }), other: any = await lead(t.admin, bystander.id);
    const preview = await transferLeads(sq(), t.admin, { fromUserId: from.id, toUserId: to.id, scope: "open", dryRun: true });
    expect(preview.count).toBe(2);
    await expect(transferLeads(sq(), t.admin, { fromUserId: from.id, toUserId: to.id, scope: "open" })).rejects.toThrow(/why/); // reason required by default
    await expect(transferLeads(sq(), t.admin, { fromUserId: from.id, toUserId: from.id, scope: "open", reason: "x" })).rejects.toThrow(/two different/);
    await expect(transferLeads(sq(), from.ctx, { fromUserId: from.id, toUserId: to.id, scope: "open", reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    const hot = await transferLeads(sq(), t.admin, { fromUserId: from.id, toUserId: to.id, scope: "hot", reason: "Handover of hot leads" });
    expect(hot).toMatchObject({ count: 1, done: 1 });
    const res = await transferLeads(sq(), t.admin, { fromUserId: from.id, toUserId: to.id, scope: "open", reason: "Agent left" });
    expect(res).toMatchObject({ count: 1, done: 1 });
    const owners = await sq().query<{ id: string; assigned_user_id: string }>("SELECT id, assigned_user_id FROM leads WHERE tenant_id=:t", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(owners.find((o) => o.id === a.lead.id)!.assigned_user_id).toBe(to.id);
    expect(owners.find((o) => o.id === b.lead.id)!.assigned_user_id).toBe(to.id);
    expect(owners.find((o) => o.id === other.lead.id)!.assigned_user_id).toBe(bystander.id);
    const hist = await sq().query<{ reason: string }>("SELECT reason FROM lead_assignments WHERE lead_id=:id AND assigned_user_id=:u", { replacements: { id: a.lead.id, u: to.id }, type: QueryTypes.SELECT });
    expect(hist[0]!.reason).toMatch(/^Transfer: Agent left/);
    // the company can stop asking for a reason
    await setSettings(sq(), t.admin, { "leads.transfer_requires_reason": false });
    await lead(t.admin, from.id);
    expect((await transferLeads(sq(), t.admin, { fromUserId: from.id, toUserId: to.id, scope: "open" })).done).toBe(1);
  });
});
