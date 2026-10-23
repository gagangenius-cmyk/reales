import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  approvePayrollRun, cancelEncashment, checkIn, clearRoster, closeReviewCycle, createEmployee, createPayrollRun, createReviewCycle, cycleReviews, dubaiDate, encashLeave, finaliseReview, getLeaveBalances, getPayrollRun,
  listEncashments, listLeaveTypes, listReviewCycles, listRoster, listShifts, saveGoals, saveLeaveType, saveShift, setRoster, setSalary, submitManagerReview, submitSelfReview, timesheet, updateEmployee,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, makeUser, testDb } from "./helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const plus = (n: number) => new Date(Date.now() + n * 86_400_000 + 4 * 3_600_000).toISOString().slice(0, 10);

describe("shift rosters", () => {
  it("overrides one date with another shift or a day off, and attendance, timesheet and the board follow it", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]), other = await makeUser(t, ["agent"]);
    const e: any = await createEmployee(sq(), t.admin, { fullName: "Night Nora", joinedOn: "2024-01-01", userId: u.id });
    const night: any = await saveShift(sq(), t.admin, { name: "Night", startTime: "00:00", endTime: "23:00", breakMinutes: 30, graceMinutes: 0, halfDayMinutes: 240, weeklyOff: ["fri"] });
    const day = dubaiDate();
    await expect(setRoster(sq(), other.ctx, { employeeIds: [e.id], from: day, to: day, shiftId: night.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setRoster(sq(), t.admin, { employeeIds: [e.id], from: day, to: day })).rejects.toThrow(/shift or mark a day off/);
    expect((await setRoster(sq(), t.admin, { employeeIds: [e.id], from: day, to: day, shiftId: night.id })).days).toBe(1);
    // starting at 00:00 with no grace, any check-in today is late; a day off is never late
    const ec = await contextFor(t.tenantId, u.id);
    const r: any = await checkIn(sq(), ec, {});
    expect(r.lateMinutes).toBeGreaterThanOrEqual(0);
    const grid: any[] = await listRoster(sq(), t.admin, day, plus(2));
    const row = grid.find((g) => g.employeeId === e.id);
    expect(row.days[0]).toMatchObject({ rostered: true, off: false, shift: "Night" });
    await setRoster(sq(), t.admin, { employeeIds: [e.id], from: plus(1), to: plus(1), dayOff: true, note: "Swapped weekend" });
    const sheet = await timesheet(sq(), t.admin, e.id, plus(1), plus(1));
    expect(sheet.days[0]!.status).toBe("weekly_off");
    await clearRoster(sq(), t.admin, { employeeIds: [e.id], from: day, to: plus(2) });
    expect((await listRoster(sq(), t.admin, day, day) as any[])[0].days[0].rostered).toBe(false);
    // an employee sees only their own roster
    expect(await listRoster(sq(), ec, day, day, true)).toHaveLength(1);
    expect((await listShifts(sq(), t.admin)).length).toBeGreaterThanOrEqual(2);
  });
});

describe("leave encashment", () => {
  it("pays out unused encashable leave in the next payroll and returns the days when cancelled", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]);
    const e: any = await createEmployee(sq(), t.admin, { fullName: "Cash Carl", joinedOn: "2020-01-01", userId: u.id });
    await setSalary(sq(), t.admin, e.id, { effectiveFrom: "2020-01-01", basic: 6000, housing: 2000, transport: 1000 });
    const types: any[] = await listLeaveTypes(sq(), t.admin);
    const annual = types.find((x) => x.code === "ANNUAL"), sick = types.find((x) => x.code === "SICK");
    await expect(encashLeave(sq(), t.admin, e.id, { leaveTypeId: sick.id, days: 1 })).rejects.toThrow(/cannot be encashed/);
    await expect(encashLeave(sq(), t.admin, e.id, { leaveTypeId: annual.id, days: 500 })).rejects.toThrow();
    await expect(encashLeave(sq(), (await makeUser(t, ["agent"])).ctx, e.id, { leaveTypeId: annual.id, days: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    const before = ((await getLeaveBalances(sq(), t.admin, e.id)).find((b: any) => b.code === "ANNUAL") as any).available;
    const x: any = await encashLeave(sq(), t.admin, e.id, { leaveTypeId: annual.id, days: 3, reason: "Final settlement" });
    expect(Number(x.amount)).toBe(600); // 3 days x basic 6000 / 30
    expect(((await getLeaveBalances(sq(), t.admin, e.id)).find((b: any) => b.code === "ANNUAL") as any).available).toBe(before - 3);
    await cancelEncashment(sq(), t.admin, x.id);
    expect(((await getLeaveBalances(sq(), t.admin, e.id)).find((b: any) => b.code === "ANNUAL") as any).available).toBe(before);
    const y: any = await encashLeave(sq(), t.admin, e.id, { leaveTypeId: annual.id, days: 2 });
    const d = new Date(Date.UTC(Number(dubaiDate().slice(0, 4)), Number(dubaiDate().slice(5, 7)) - 2, 1));
    const period = d.toISOString().slice(0, 7);
    const run: any = await createPayrollRun(sq(), t.admin, period);
    const slip = ((await getPayrollRun(sq(), t.admin, run.id)) as any).payslips[0];
    expect(slip.earnings.some((l: any) => /encashment \(2 days\)/.test(l.name) && l.amount === 400)).toBe(true);
    await approvePayrollRun(sq(), t.admin, run.id);
    expect((await listEncashments(sq(), t.admin, e.id) as any[]).find((r) => r.id === y.id).status).toBe("paid");
    await expect(cancelEncashment(sq(), t.admin, y.id)).rejects.toThrow(/not yet/);
    // HR can make any leave type encashable
    await saveLeaveType(sq(), t.admin, { ...sick, annualDays: 15, carryForwardMax: 0, encashable: true } as never);
    expect((await encashLeave(sq(), t.admin, e.id, { leaveTypeId: sick.id, days: 1 }) as any).status).toBe("pending");
    void updateEmployee; void QueryTypes;
  });
});

describe("performance reviews", () => {
  it("runs a cycle: goals, self-assessment, manager rating hidden until final, HR finalises, cycle closes", async () => {
    const t = await makeTenant();
    const mgrU = await makeUser(t, ["agent"]), empU = await makeUser(t, ["agent"]), other = await makeUser(t, ["agent"]);
    const mgr: any = await createEmployee(sq(), t.admin, { fullName: "Mia Manager", joinedOn: "2020-01-01", userId: mgrU.id });
    const emp: any = await createEmployee(sq(), t.admin, { fullName: "Eve Employee", joinedOn: "2021-01-01", userId: empU.id, managerEmployeeId: mgr.id });
    await expect(createReviewCycle(sq(), other.ctx, { name: "x", periodStart: "2026-01-01", periodEnd: "2026-06-30" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createReviewCycle(sq(), t.admin, { name: "x", periodStart: "2026-06-30", periodEnd: "2026-01-01" })).rejects.toThrow(/period/);
    const cycle: any = await createReviewCycle(sq(), t.admin, { name: "H1 2026", periodStart: "2026-01-01", periodEnd: "2026-06-30" });
    expect(cycle.reviews).toBe(2);
    const ec = await contextFor(t.tenantId, empU.id), mc = await contextFor(t.tenantId, mgrU.id);
    const mine: any = (await cycleReviews(sq(), ec, cycle.id)).reviews;
    expect(mine).toHaveLength(1); // an employee sees only their own review
    const rid = mine[0].id;
    expect((await cycleReviews(sq(), mc, cycle.id) as any).reviews.map((r: any) => r.employeeName).sort()).toEqual(["Eve Employee", "Mia Manager"]); // the manager sees their reports and their own review
    await expect(cycleReviews(sq(), other.ctx, cycle.id).then((r: any) => r.reviews)).resolves.toHaveLength(0);
    await expect(saveGoals(sq(), ec, rid, [{ title: "A", weight: 70 }, { title: "B", weight: 50 }])).rejects.toThrow(/more than 100/);
    await saveGoals(sq(), ec, rid, [{ title: "Close 10 deals", weight: 60, progress: 40 }, { title: "Improve response time", weight: 40 }]);
    await expect(submitSelfReview(sq(), ec, rid, { rating: 9, comments: "ok" })).rejects.toThrow(/1 to 5/);
    await expect(submitManagerReview(sq(), ec, rid, { rating: 4, comments: "I rate myself" })).rejects.toThrow(/cannot rate yourself/);
    await submitSelfReview(sq(), ec, rid, { rating: 4, comments: "A strong half" });
    await expect(submitSelfReview(sq(), ec, rid, { rating: 4, comments: "again" })).rejects.toThrow(/already submitted/);
    await expect(submitManagerReview(sq(), other.ctx, rid, { rating: 3, comments: "x" })).rejects.toThrow(/not found/i);
    await submitManagerReview(sq(), mc, rid, { rating: 3, comments: "Good but response time needs work" });
    const hidden: any = (await cycleReviews(sq(), ec, cycle.id)).reviews[0];
    expect(hidden.managerRating).toBeNull(); // not shown to the employee before it is final
    await expect(finaliseReview(sq(), mc, rid, { finalRating: 3 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(closeReviewCycle(sq(), t.admin, cycle.id)).rejects.toThrow(/not final/);
    await finaliseReview(sq(), t.admin, rid, { finalRating: 3, outcome: "Performance plan" });
    const visible: any = (await cycleReviews(sq(), ec, cycle.id)).reviews[0];
    expect(visible).toMatchObject({ managerRating: 3, finalRating: 3, status: "finalised" });
    await expect(saveGoals(sq(), ec, rid, [{ title: "late" }])).rejects.toThrow(/final/);
    // the manager's own review still needs finishing before the cycle can close
    const mgrReview: any = (await cycleReviews(sq(), t.admin, cycle.id)).reviews.find((r: any) => r.employeeName === "Mia Manager");
    await submitSelfReview(sq(), mc, mgrReview.id, { rating: 5, comments: "Team delivered" });
    await submitManagerReview(sq(), t.admin, mgrReview.id, { rating: 4, comments: "Solid" });
    await finaliseReview(sq(), t.admin, mgrReview.id, { finalRating: 4 });
    await closeReviewCycle(sq(), t.admin, cycle.id);
    expect((await listReviewCycles(sq(), t.admin) as any[])[0].status).toBe("closed");
  });
});
