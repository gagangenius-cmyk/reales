import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize, hasPermission } from "@reales/rbac";
import { dubaiDate, selfEmployee } from "./hr";
import { notifyUser } from "./notify";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = /^\d{4}-\d{2}-\d{2}$/;

/* ---------------------------------------------------------------------------------------------- leave encashment */

/**
 * Paying out unused leave instead of the employee taking it. Only leave types marked encashable qualify. The value of a day is basic salary / 30 (the UAE
 * basis for annual leave pay). The balance drops straight away and the amount is added to the next payroll run, which marks it paid when approved.
 */
export async function encashLeave(sq: Sequelize, ctx: RequestContext, employeeId: string, i: { leaveTypeId: string; days: number; reason?: string; year?: number }) {
  authorize(ctx, "hr.salary");
  if (!(i.days > 0) || i.days > 365) throw new ConflictError("Enter the number of days to encash");
  return withUow(sq, ctx, async (u) => {
    const e: any = await u.repo("HrEmployee").findById(employeeId, { transaction: u.tx });
    if (!e) throw new NotFoundError("Employee");
    const t: any = await u.repo("HrLeaveType").findById(i.leaveTypeId, { transaction: u.tx });
    if (!t) throw new NotFoundError("Leave type");
    if (!t.get("encashable")) throw new ConflictError(`${t.get("name")} cannot be encashed. Mark it encashable in HR setup first.`);
    const year = i.year ?? Number(dubaiDate().slice(0, 4));
    const { getLeaveBalances } = await import("./hr");
    const bal = (await getLeaveBalances(sq, ctx, employeeId, year)).find((b: any) => b.leaveTypeId === i.leaveTypeId);
    if (!bal || bal.unlimited || (bal.available ?? 0) < i.days) throw new ConflictError(`Only ${bal?.available ?? 0} day(s) of ${t.get("name")} are available to encash`);
    const sal: any = await u.repo("HrSalary").findOne({ where: { employeeId, effectiveFrom: { [Op.lte]: dubaiDate() } }, order: [["effectiveFrom", "DESC"], ["createdAt", "DESC"]], transaction: u.tx });
    if (!sal) throw new ConflictError("Set the employee's salary first");
    const rate = r2(Number(sal.get("basic")) / 30), id = randomUUID();
    await u.repo("HrEncashment").create({ id, employeeId, leaveTypeId: i.leaveTypeId, year, days: i.days, dailyRate: rate, amount: r2(rate * i.days), status: "pending", reason: i.reason?.trim().slice(0, 200) || null, createdBy: ctx.userId }, { transaction: u.tx });
    const row: any = await u.repo("HrLeaveBalance").findOne({ where: { employeeId, leaveTypeId: i.leaveTypeId, year }, transaction: u.tx });
    if (row) await u.repo("HrLeaveBalance").updateById(row.get("id"), { adjusted: Number(row.get("adjusted")) - i.days, note: "Encashed" }, { transaction: u.tx });
    else await u.repo("HrLeaveBalance").create({ id: randomUUID(), employeeId, leaveTypeId: i.leaveTypeId, year, entitled: 0, carried: 0, adjusted: -i.days, note: "Encashed" }, { transaction: u.tx });
    await u.audit({ action: "hr.leave_encashed", entityType: "hr_employee", entityId: employeeId, after: { type: t.get("code"), days: i.days, amount: r2(rate * i.days) }, reason: i.reason });
    return plain(await u.repo("HrEncashment").findById(id, { transaction: u.tx }));
  });
}

export async function listEncashments(sq: Sequelize, ctx: RequestContext, employeeId?: string) {
  authorize(ctx, "hr.salary");
  return withUow(sq, ctx, async (u) => {
    const rows = (await u.repo("HrEncashment").findAll({ where: employeeId ? { employeeId } : {}, order: [["createdAt", "DESC"]], limit: 200, transaction: u.tx })) as any[];
    const emps = new Map(((await u.repo("HrEmployee").findAll({ where: { id: { [Op.in]: rows.map((r) => r.get("employeeId")).concat(["-"]) } }, attributes: ["id", "fullName"], transaction: u.tx })) as any[]).map((e) => [e.get("id"), e.get("fullName") as string]));
    const types = new Map(((await u.repo("HrLeaveType").findAll({ transaction: u.tx })) as any[]).map((t) => [t.get("id"), t.get("name") as string]));
    return rows.map((r) => ({ ...plain(r), days: Number(r.get("days")), dailyRate: Number(r.get("dailyRate")), amount: Number(r.get("amount")), employeeName: emps.get(r.get("employeeId")) ?? "", typeName: types.get(r.get("leaveTypeId")) ?? "" }));
  });
}

export async function cancelEncashment(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.salary");
  return withUow(sq, ctx, async (u) => {
    const x: any = await u.repo("HrEncashment").findById(id, { transaction: u.tx });
    if (!x) throw new NotFoundError("Encashment");
    if (x.get("status") !== "pending") throw new ConflictError("Only an encashment that is not yet in an approved payroll can be cancelled");
    await u.repo("HrEncashment").updateById(id, { status: "cancelled" }, { transaction: u.tx });
    const row: any = await u.repo("HrLeaveBalance").findOne({ where: { employeeId: x.get("employeeId"), leaveTypeId: x.get("leaveTypeId"), year: x.get("year") }, transaction: u.tx });
    if (row) await u.repo("HrLeaveBalance").updateById(row.get("id"), { adjusted: Number(row.get("adjusted")) + Number(x.get("days")) }, { transaction: u.tx });
    await u.audit({ action: "hr.encashment_cancelled", entityType: "hr_encashment", entityId: id });
    return { id };
  });
}

/* ---------------------------------------------------------------------------------------------- performance reviews */

export interface Goal { title: string; weight?: number; target?: string; progress?: number }
const ratingOk = (n: number, scale: number) => Number.isInteger(n) && n >= 1 && n <= scale;

async function loadReview(u: Uow, id: string) {
  const r: any = await u.repo("HrReview").findById(id, { transaction: u.tx });
  if (!r) throw new NotFoundError("Review");
  const cycle: any = await u.repo("HrReviewCycle").findById(r.get("cycleId"), { transaction: u.tx });
  const emp: any = await u.repo("HrEmployee").findById(r.get("employeeId"), { transaction: u.tx });
  return { r, cycle, emp };
}

/** Opens a review cycle and creates one review per active employee who had joined by the end of the period, with their manager as reviewer. */
export async function createReviewCycle(sq: Sequelize, ctx: RequestContext, i: { name: string; periodStart: string; periodEnd: string; ratingScale?: number }) {
  authorize(ctx, "hr.manage");
  if (!i.name.trim()) throw new ConflictError("Name the review cycle");
  if (!ymd.test(i.periodStart) || !ymd.test(i.periodEnd) || i.periodEnd < i.periodStart) throw new ConflictError("Check the review period");
  const scale = i.ratingScale ?? 5;
  if (![3, 4, 5, 10].includes(scale)) throw new ConflictError("Rating scale must be 3, 4, 5 or 10");
  return withUow(sq, ctx, async (u) => {
    const id = randomUUID();
    await u.repo("HrReviewCycle").create({ id, name: i.name.trim().slice(0, 120), periodStart: i.periodStart, periodEnd: i.periodEnd, status: "open", ratingScale: scale, createdBy: ctx.userId }, { transaction: u.tx });
    const emps = (await u.repo("HrEmployee").findAll({ where: { status: { [Op.ne]: "exited" }, joinedOn: { [Op.lte]: i.periodEnd } }, transaction: u.tx })) as any[];
    for (const e of emps) {
      await u.repo("HrReview").create({ id: randomUUID(), cycleId: id, employeeId: e.get("id"), reviewerEmployeeId: e.get("managerEmployeeId") ?? null, goals: [], status: "pending" }, { transaction: u.tx });
      if (e.get("userId")) await notifyUser(u, { userId: e.get("userId"), kind: "hr.review", title: `Performance review open: ${i.name.trim()}`, body: "Add your goals and complete your self-assessment.", entityType: "hr_review_cycle", entityId: id, dedupeKey: `review.open:${id}:${e.get("id")}`, path: "/hr/performance" });
    }
    await u.audit({ action: "hr.review_cycle_opened", entityType: "hr_review_cycle", entityId: id, after: { name: i.name, reviews: emps.length } });
    return { ...plain(await u.repo("HrReviewCycle").findById(id, { transaction: u.tx })), reviews: emps.length };
  });
}

export async function listReviewCycles(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    const cycles = (await u.repo("HrReviewCycle").findAll({ order: [["periodEnd", "DESC"]], limit: 24, transaction: u.tx })) as any[];
    const counts = new Map<string, { total: number; done: number }>();
    if (hasPermission(ctx, "hr.read")) for (const c of cycles) { const rs = (await u.repo("HrReview").findAll({ where: { cycleId: c.get("id") }, attributes: ["status"], transaction: u.tx })) as any[]; counts.set(c.get("id"), { total: rs.length, done: rs.filter((x) => x.get("status") === "finalised").length }); }
    return cycles.map((c) => ({ ...plain(c), ...(counts.get(c.get("id")) ?? {}) }));
  });
}

function reviewView(ctx: RequestContext, r: any, emp: any, myEmpId: string | null, isHr: boolean) {
  const p = plain(r), mine = emp.get("userId") === ctx.userId, mgr = !!myEmpId && r.get("reviewerEmployeeId") === myEmpId;
  const hideManager = mine && !isHr && !mgr && p.status !== "finalised"; // an employee sees the manager's view only once it is final
  return { ...p, employeeName: emp.get("fullName") as string, employeeNo: emp.get("employeeNo") as string, designation: emp.get("designation") as string | null, goals: (p.goals ?? []) as Goal[],
    managerRating: hideManager ? null : p.managerRating, managerComments: hideManager ? null : p.managerComments, finalRating: p.status === "finalised" || isHr || mgr ? p.finalRating : null,
    canSelf: mine && ["pending"].includes(p.status), canManager: (mgr || isHr) && ["pending", "self_submitted", "manager_submitted"].includes(p.status) && !mine, canFinalise: isHr && p.status !== "finalised", canGoals: (mine || mgr || isHr) && p.status !== "finalised" };
}

/** Reviews the caller may see in a cycle: all with hr.read, their reports' as a manager, their own as an employee. */
export async function cycleReviews(sq: Sequelize, ctx: RequestContext, cycleId: string) {
  return withUow(sq, ctx, async (u) => {
    const cycle: any = await u.repo("HrReviewCycle").findById(cycleId, { transaction: u.tx });
    if (!cycle) throw new NotFoundError("Review cycle");
    const me = await selfEmployee(u, ctx), isHr = hasPermission(ctx, "hr.manage"), read = hasPermission(ctx, "hr.read");
    const rows = (await u.repo("HrReview").findAll({ where: { cycleId }, transaction: u.tx })) as any[];
    const out = [];
    for (const r of rows) {
      const emp: any = await u.repo("HrEmployee").findById(r.get("employeeId"), { transaction: u.tx });
      const mine = emp.get("userId") === ctx.userId, mgr = !!me && r.get("reviewerEmployeeId") === me.get("id");
      if (read || mine || mgr) out.push(reviewView(ctx, r, emp, me?.get("id") ?? null, isHr));
    }
    return { cycle: plain(cycle), reviews: out.sort((a, b) => a.employeeName.localeCompare(b.employeeName)) };
  });
}

async function access(u: Uow, ctx: RequestContext, id: string) {
  const { r, cycle, emp } = await loadReview(u, id);
  const me = await selfEmployee(u, ctx), isHr = hasPermission(ctx, "hr.manage");
  const mine = emp.get("userId") === ctx.userId, mgr = !!me && r.get("reviewerEmployeeId") === me.get("id");
  if (!mine && !mgr && !isHr) throw new NotFoundError("Review");
  if (cycle.get("status") !== "open") throw new ConflictError("This review cycle is closed");
  if (r.get("status") === "finalised") throw new ConflictError("This review is final");
  return { r, cycle, emp, mine, mgr, isHr, me };
}

export async function saveGoals(sq: Sequelize, ctx: RequestContext, id: string, goals: Goal[]) {
  if (goals.length > 15) throw new ConflictError("At most 15 goals");
  for (const g of goals) { if (!g.title?.trim()) throw new ConflictError("Every goal needs a title"); if (g.weight !== undefined && (g.weight < 0 || g.weight > 100)) throw new ConflictError("Weight is 0 to 100"); if (g.progress !== undefined && (g.progress < 0 || g.progress > 100)) throw new ConflictError("Progress is 0 to 100"); }
  if (goals.reduce((a, g) => a + (g.weight ?? 0), 0) > 100) throw new ConflictError("Goal weights add up to more than 100");
  return withUow(sq, ctx, async (u) => {
    await access(u, ctx, id);
    await u.repo("HrReview").updateById(id, { goals: goals.map((g) => ({ title: g.title.trim().slice(0, 160), weight: g.weight ?? null, target: g.target?.trim().slice(0, 200) || null, progress: g.progress ?? 0 })) }, { transaction: u.tx });
    return { ok: true };
  });
}

export async function submitSelfReview(sq: Sequelize, ctx: RequestContext, id: string, i: { rating: number; comments: string }) {
  return withUow(sq, ctx, async (u) => {
    const { r, cycle, mine, emp } = await access(u, ctx, id);
    if (!mine) throw new ConflictError("Only the employee writes their own self-assessment");
    if (r.get("status") !== "pending") throw new ConflictError("Your self-assessment is already submitted");
    if (!ratingOk(i.rating, cycle.get("ratingScale"))) throw new ConflictError(`Rate yourself from 1 to ${cycle.get("ratingScale")}`);
    if (!i.comments?.trim()) throw new ConflictError("Add a few words about the period");
    await u.repo("HrReview").updateById(id, { selfRating: i.rating, selfComments: i.comments.trim().slice(0, 4000), status: "self_submitted" }, { transaction: u.tx });
    const mgr: any = r.get("reviewerEmployeeId") ? await u.repo("HrEmployee").findById(r.get("reviewerEmployeeId"), { transaction: u.tx }) : null;
    if (mgr?.get("userId")) await notifyUser(u, { userId: mgr.get("userId"), kind: "hr.review", title: `${emp.get("fullName")} submitted a self-assessment`, entityType: "hr_review", entityId: id, dedupeKey: `review.self:${id}`, path: "/hr/performance" });
    return { ok: true };
  });
}

export async function submitManagerReview(sq: Sequelize, ctx: RequestContext, id: string, i: { rating: number; comments: string }) {
  return withUow(sq, ctx, async (u) => {
    const { r, cycle, mine, mgr, isHr } = await access(u, ctx, id);
    if (mine) throw new ConflictError("You cannot rate yourself as the manager");
    if (!mgr && !isHr) throw new NotFoundError("Review");
    if (!ratingOk(i.rating, cycle.get("ratingScale"))) throw new ConflictError(`Rate from 1 to ${cycle.get("ratingScale")}`);
    if (!i.comments?.trim()) throw new ConflictError("Add your feedback");
    await u.repo("HrReview").updateById(id, { managerRating: i.rating, managerComments: i.comments.trim().slice(0, 4000), status: "manager_submitted" }, { transaction: u.tx });
    await u.audit({ action: "hr.review_manager_submitted", entityType: "hr_review", entityId: id, after: { rating: i.rating } });
    void r;
    return { ok: true };
  });
}

/** HR sets the final rating and outcome (promotion, raise, plan, none). The employee sees the manager's feedback only from this point. */
export async function finaliseReview(sq: Sequelize, ctx: RequestContext, id: string, i: { finalRating: number; outcome?: string }) {
  authorize(ctx, "hr.manage");
  return withUow(sq, ctx, async (u) => {
    const { r, cycle, emp } = await access(u, ctx, id);
    if (r.get("status") === "pending" || r.get("status") === "self_submitted") throw new ConflictError("The manager's review must be submitted first");
    if (!ratingOk(i.finalRating, cycle.get("ratingScale"))) throw new ConflictError(`Final rating is 1 to ${cycle.get("ratingScale")}`);
    await u.repo("HrReview").updateById(id, { finalRating: i.finalRating, outcome: i.outcome?.trim().slice(0, 200) || null, status: "finalised", finalisedBy: ctx.userId, finalisedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "hr.review_finalised", entityType: "hr_review", entityId: id, after: { employee: emp.get("employeeNo"), finalRating: i.finalRating, outcome: i.outcome ?? null } });
    if (emp.get("userId")) await notifyUser(u, { userId: emp.get("userId"), kind: "hr.review", title: `Your performance review is final: ${cycle.get("name")}`, entityType: "hr_review", entityId: id, dedupeKey: `review.final:${id}`, path: "/hr/performance" });
    return { ok: true };
  });
}

export async function closeReviewCycle(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.manage");
  return withUow(sq, ctx, async (u) => {
    const c: any = await u.repo("HrReviewCycle").findById(id, { transaction: u.tx });
    if (!c) throw new NotFoundError("Review cycle");
    const open = await u.repo("HrReview").count({ where: { cycleId: id, status: { [Op.ne]: "finalised" } }, transaction: u.tx });
    if (open > 0) throw new ConflictError(`${open} review(s) are not final yet`);
    await u.repo("HrReviewCycle").updateById(id, { status: "closed" }, { transaction: u.tx });
    await u.audit({ action: "hr.review_cycle_closed", entityType: "hr_review_cycle", entityId: id });
    return { id };
  });
}
