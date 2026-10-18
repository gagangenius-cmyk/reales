import { afterAll, describe, expect, it } from "vitest";
import {
  createCommissionPlan, createCustomRole, createDeal, createReservation, deleteCustomRole, listCommissions, listRoles, listUserRoles, markCommissionPaid, approveCommission,
  revokeUserRole, scheduleViewing, setRoleGrants, setWeeklyAvailability, addTimeOff, freeSlots, upsertAgentProfile, createLead, listAssignableUsers,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, testDb, uniq } from "./helpers";
import { acceptedOffer, kit, phone, walkTo } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);

/** Next given Dubai weekday (0 = Sunday) at hh:00 Dubai time, at least two days ahead. */
function dubai(weekday: number, hh: number, minutes = 0) {
  const d = new Date(Date.now() + 2 * 86_400_000);
  for (let i = 0; i < 8; i++) { if (new Date(d.getTime() + 4 * 3_600_000).getUTCDay() === weekday) break; d.setTime(d.getTime() + 86_400_000); }
  const day = new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
  return `${day}T${String(hh).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00+04:00`;
}

describe("agent types and commissions", () => {
  it("picks the plan by agent type, adds VAT, and records the payout once approved", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await createCommissionPlan(sq(), t.admin, { name: "Any", dealType: "sale", ratePct: 2, splits: [{ role: "agent", pct: 50 }, { role: "company", pct: 50 }] });
    await createCommissionPlan(sq(), t.admin, { name: "External", dealType: "sale", agentType: "external", ratePct: 3, vatPct: 5, splits: [{ role: "agent", pct: 70 }, { role: "company", pct: 30 }] });
    await expect(upsertAgentProfile(sq(), t.admin, { userId: k.agent.id, agentType: "external" })).rejects.toThrow(/agency/);
    await upsertAgentProfile(sq(), t.admin, { userId: k.agent.id, agentType: "external", agencyName: "Partner Realty", brn: "BRN-77" });

    const offer = await acceptedOffer(t, k, { amount: 1_000_000 });
    const res = await createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id, depositAmount: 50_000 });
    const deal = await createDeal(sq(), k.mgr.ctx, { reservationId: res.id });
    await walkTo(k, deal.id, "closed");

    const [calc] = await listCommissions(sq(), t.admin, { limit: 10, offset: 0 });
    expect(calc.agentType).toBe("external");
    expect(Number(calc.commissionAmount)).toBe(30_000); // the external plan (3%), not the generic 2%
    expect(Number(calc.vatAmount)).toBe(1_500); // 5% VAT on the commission
    expect(calc.splits.find((s: any) => s.role === "agent").amount).toBe("21000.00");

    await expect(markCommissionPaid(sq(), t.admin, calc.id, "TRX-1")).rejects.toThrow(/approved/);
    await approveCommission(sq(), t.admin, calc.id);
    await expect(markCommissionPaid(sq(), t.admin, calc.id, "  ")).rejects.toThrow(/reference/);
    const paid = await markCommissionPaid(sq(), t.admin, calc.id, "TRX-1");
    expect(paid.paidReference).toBe("TRX-1");
    await expect(markCommissionPaid(sq(), t.admin, calc.id, "TRX-2")).rejects.toThrow(/already paid/);
    await expect(upsertAgentProfile(sq(), k.agent.ctx, { userId: k.agent.id, agentType: "internal" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("agent availability", () => {
  it("only books inside working hours, outside time off, and lists the free slots", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await setWeeklyAvailability(sq(), t.admin, k.agent.id, [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "18:00" })));
    await expect(setWeeklyAvailability(sq(), t.admin, k.agent.id, [{ weekday: 1, startTime: "09:00", endTime: "12:00" }, { weekday: 1, startTime: "11:00", endTime: "14:00" }])).rejects.toThrow(/overlap/);
    await setWeeklyAvailability(sq(), t.admin, k.agent.id, [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "18:00" })));
    const book = (at: string) => scheduleViewing(sq(), k.mgr.ctx, { contactId: k.contact.id, agentUserId: k.agent.id, scheduledAt: at });

    await expect(book(dubai(0, 11))).rejects.toThrow(/not available/); // Sunday
    await expect(book(dubai(2, 8, 30))).rejects.toThrow(/not available/); // before opening
    await expect(book(dubai(2, 17, 45))).rejects.toThrow(/not available/); // would end after 18:00
    const ok = await book(dubai(3, 11));
    expect(ok.status).toBe("scheduled");
    await expect(book(dubai(3, 11))).rejects.toThrow(/already has a viewing/);

    await addTimeOff(sq(), t.admin, k.agent.id, { startsAt: new Date(dubai(4, 9)).toISOString(), endsAt: new Date(dubai(4, 17)).toISOString(), reason: "Leave" });
    await expect(book(dubai(4, 12))).rejects.toThrow(/time off/);

    const day = dubai(3, 9).slice(0, 10);
    const { slots, restricted } = await freeSlots(sq(), t.admin, k.agent.id, day, 30);
    expect(restricted).toBe(true);
    expect(slots).not.toContain(new Date(dubai(3, 11)).toISOString());
    expect(slots).toContain(new Date(dubai(3, 10)).toISOString());
    expect(slots).not.toContain(new Date(dubai(3, 18)).toISOString());

    // An agent with no hours is not restricted.
    const free = await kit(t);
    expect((await scheduleViewing(sq(), t.admin, { contactId: free.contact.id, agentUserId: free.agent.id, scheduledAt: dubai(0, 23) })).status).toBe("scheduled");
  });
});

describe("roles and permissions", () => {
  it("copies a system role, edits it, assigns it, and protects system roles and the last admin", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const roles: any[] = (await listRoles(sq(), t.admin)) as any[];
    const agentRole = roles.find((r) => r.key === "agent");
    const copy = await createCustomRole(sq(), t.admin, { name: uniq("Senior Agent"), copyFromRoleId: agentRole.id, grants: [] });
    await expect(createCustomRole(sq(), t.admin, { name: copy.name, grants: [] })).rejects.toThrow(/already exists/);
    await expect(setRoleGrants(sq(), t.admin, agentRole.id, { grants: [] })).rejects.toThrow(/System roles are fixed/);
    await expect(setRoleGrants(sq(), t.admin, copy.id, { grants: [{ permission: "nonsense.perm", scope: "tenant" }] })).rejects.toThrow(/Unknown permission/);
    await setRoleGrants(sq(), t.admin, copy.id, { grants: [{ permission: "lead.read", scope: "branch" }, { permission: "contact.read", scope: "own_records" }] });
    // Someone without role.manage cannot edit it, and cannot grant what they do not hold.
    await expect(setRoleGrants(sq(), k.agent.ctx, copy.id, { grants: [{ permission: "lead.read", scope: "tenant" }] })).rejects.toBeInstanceOf(ForbiddenError);

    const { assignRole } = await import("@reales/domain");
    await assignRole(sq(), t.admin, k.other.id, { roleKey: copy.key });
    const held = await listUserRoles(sq(), t.admin);
    const mine = held.find((h) => h.userId === k.other.id && h.roleKey === copy.key)!;
    await expect(deleteCustomRole(sq(), t.admin, copy.id)).rejects.toThrow(/Remove this role/);
    await revokeUserRole(sq(), t.admin, k.other.id, mine.userRoleId);
    await deleteCustomRole(sq(), t.admin, copy.id);
    expect((await listRoles(sq(), t.admin) as any[]).some((r) => r.id === copy.id)).toBe(false);

    const adminRow = (await listUserRoles(sq(), t.admin)).find((h) => h.roleKey === "tenant_admin")!;
    await expect(revokeUserRole(sq(), t.admin, adminRow.userId, adminRow.userRoleId)).rejects.toThrow(/own administrator role|at least one administrator/);
  });
});

describe("lead owner choices", () => {
  it("lets an admin pick anyone, a manager only their branch, and an agent only themselves", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const adminIds = (await listAssignableUsers(sq(), t.admin)).map((u) => u.id);
    expect(adminIds).toEqual(expect.arrayContaining([k.agent.id, k.other.id, k.mgr.id]));
    const mgrIds = (await listAssignableUsers(sq(), k.mgr.ctx)).map((u) => u.id);
    expect(mgrIds).toEqual(expect.arrayContaining([k.agent.id, k.other.id, k.mgr.id]));
    expect((await listAssignableUsers(sq(), k.agent.ctx)).map((u) => u.id)).toEqual([k.agent.id]);

    const mk = (ctx: any, assignedUserId: string) => createLead(sq(), ctx, { contact: { firstName: uniq("L"), phone: phone() }, purpose: "buy", sourceCode: "walk_in", isHot: true, campaign: "Test", assignedUserId });
    const ok = await mk(k.agent.ctx, k.agent.id);
    expect(ok.assignedUserId).toBe(k.agent.id);
    expect(ok.lead).toMatchObject({ isHot: true, campaign: "Test" });
    await expect(mk(k.agent.ctx, k.other.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await mk(t.admin, k.other.id)).assignedUserId).toBe(k.other.id);
    void contextFor;
  });
});
