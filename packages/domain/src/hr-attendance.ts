import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize, hasPermission } from "@reales/rbac";
import { getSetting } from "./config";
import { dayPlan, planRange } from "./hr-roster";
import { dubaiDate, dubaiMinutes, ensureHrDefaults, selfEmployee } from "./hr";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

const MIN = 60_000;
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const dow = (s: string) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${s}T00:00:00Z`).getUTCDay()]!;
const hhmm = (s: string) => { const [h, m] = s.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

async function shiftOf(u: Uow, e: any) {
  const s: any = e.get("shiftId") ? await u.repo("HrShift").findById(e.get("shiftId"), { transaction: u.tx }) : null;
  return { start: hhmm(s?.get("startTime") ?? "09:00"), end: hhmm(s?.get("endTime") ?? "18:00"), grace: Number(s?.get("graceMinutes") ?? 10), halfDay: Number(s?.get("halfDayMinutes") ?? 240), weeklyOff: (s?.get("weeklyOff") as string[] | null) ?? ["sat", "sun"] };
}

/** Minutes of breaks already finished, plus the one still running (counted up to `at`). */
async function breakMinutes(u: Uow, attendanceId: string, at: Date) {
  const rows = (await u.repo("HrBreak").findAll({ where: { attendanceId }, transaction: u.tx })) as any[];
  return Math.round(rows.reduce((a, b) => a + Math.max(0, ((b.get("endedAt") ? +new Date(b.get("endedAt")) : +at) - +new Date(b.get("startedAt"))) / MIN), 0));
}

export type DayState = "not_started" | "working" | "on_break" | "done" | "on_leave";

async function todayRow(u: Uow, e: any, day = dubaiDate()) {
  const att: any = await u.repo("HrAttendance").findOne({ where: { employeeId: e.get("id"), workDate: day }, transaction: u.tx });
  const open: any = att ? await u.repo("HrBreak").findOne({ where: { attendanceId: att.get("id"), endedAt: null }, transaction: u.tx }) : null;
  const state: DayState = !att || (!att.get("checkInAt") && att.get("status") !== "on_leave") ? "not_started" : !att.get("checkInAt") ? "on_leave" : att.get("checkOutAt") ? "done" : open ? "on_break" : "working";
  return { att, open, state };
}

/** What the signed-in employee sees: their state today, running timers, and which actions are available. */
export async function myAttendanceToday(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    await ensureHrDefaults(u);
    const e = await selfEmployee(u, ctx);
    if (!e) return { linked: false as const };
    const { att, open, state } = await todayRow(u, e);
    const sh = await dayPlan(u, e, dubaiDate());
    const now = new Date();
    return {
      linked: true as const, employee: { id: e.get("id") as string, name: e.get("fullName") as string }, state, allowed: await getSetting<boolean>(u.sq, ctx.tenantId, "hr.attendance.allow_web_checkin"),
      shift: { start: sh.start, end: sh.end }, checkInAt: att?.get("checkInAt") ? new Date(att.get("checkInAt")).toISOString() : null, checkOutAt: att?.get("checkOutAt") ? new Date(att.get("checkOutAt")).toISOString() : null,
      lateMinutes: Number(att?.get("lateMinutes") ?? 0), breakMinutes: att ? await breakMinutes(u, att.get("id"), now) : 0, workedMinutes: att?.get("checkOutAt") ? Number(att.get("workedMinutes")) : att?.get("checkInAt") ? Math.max(0, Math.round((+now - +new Date(att.get("checkInAt"))) / MIN) - (await breakMinutes(u, att.get("id"), now))) : 0,
      openBreak: open ? { kind: open.get("kind") as string, startedAt: new Date(open.get("startedAt")).toISOString() } : null, serverTime: now.toISOString(),
    };
  });
}

async function selfOrFail(u: Uow, ctx: RequestContext) {
  const e = await selfEmployee(u, ctx);
  if (!e) throw new ConflictError("Your login is not linked to an employee record. Ask HR.");
  if (e.get("status") === "exited") throw new ConflictError("This employee has left");
  if (!(await getSetting<boolean>(u.sq, ctx.tenantId, "hr.attendance.allow_web_checkin"))) throw new ConflictError("Check-in from the CRM is switched off. Ask HR to record your attendance.");
  return e;
}

export async function checkIn(sq: Sequelize, ctx: RequestContext, o: { note?: string; source?: "web" | "mobile"; ip?: string | null } = {}) {
  return withUow(sq, ctx, async (u) => {
    const e = await selfOrFail(u, ctx);
    const day = dubaiDate(), now = new Date();
    const existing: any = await u.repo("HrAttendance").findOne({ where: { employeeId: e.get("id"), workDate: day }, transaction: u.tx });
    if (existing?.get("checkInAt")) throw new ConflictError("You already checked in today");
    const sh = await dayPlan(u, e, day);
    const late = sh.off ? 0 : Math.max(0, dubaiMinutes(now) - (sh.start + sh.grace)); // no lateness on a day off
    const vals = { checkInAt: now, status: late > 0 ? "late" : "present", lateMinutes: late, source: o.source ?? "web", ip: o.ip ?? null, note: o.note?.trim().slice(0, 300) || null, workedMinutes: 0, breakMinutes: 0 };
    let id = existing?.get("id") as string | undefined;
    if (existing) await u.repo("HrAttendance").updateById(existing.get("id"), vals, { transaction: u.tx });
    else { id = randomUUID(); await u.repo("HrAttendance").create({ id, employeeId: e.get("id"), workDate: day, ...vals }, { transaction: u.tx }); }
    await u.audit({ action: "hr.checked_in", entityType: "hr_attendance", entityId: id!, after: { late } });
    return { state: "working" as const, checkInAt: now.toISOString(), lateMinutes: late };
  });
}

export async function startBreak(sq: Sequelize, ctx: RequestContext, kind: "lunch" | "tea" | "prayer" | "other" = "lunch") {
  return withUow(sq, ctx, async (u) => {
    const e = await selfOrFail(u, ctx);
    const { att, open, state } = await todayRow(u, e);
    if (state === "not_started" || state === "on_leave") throw new ConflictError("Check in first");
    if (state === "done") throw new ConflictError("You already checked out");
    if (open) throw new ConflictError("You are already on a break");
    const id = randomUUID();
    await u.repo("HrBreak").create({ id, attendanceId: att.get("id"), kind, startedAt: new Date() }, { transaction: u.tx });
    return { state: "on_break" as const, kind, startedAt: new Date().toISOString() };
  });
}

export async function endBreak(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    const e = await selfOrFail(u, ctx);
    const { att, open } = await todayRow(u, e);
    if (!open) throw new ConflictError("You are not on a break");
    const now = new Date();
    await u.repo("HrBreak").updateById(open.get("id"), { endedAt: now }, { transaction: u.tx });
    const total = await breakMinutes(u, att.get("id"), now);
    await u.repo("HrAttendance").updateById(att.get("id"), { breakMinutes: total }, { transaction: u.tx });
    return { state: "working" as const, breakMinutes: total };
  });
}

export async function checkOut(sq: Sequelize, ctx: RequestContext, o: { note?: string } = {}) {
  return withUow(sq, ctx, async (u) => {
    const e = await selfOrFail(u, ctx);
    const { att, open, state } = await todayRow(u, e);
    if (state === "not_started") throw new ConflictError("You have not checked in today");
    if (state === "done") throw new ConflictError("You already checked out");
    const now = new Date();
    if (open) await u.repo("HrBreak").updateById(open.get("id"), { endedAt: now }, { transaction: u.tx }); // a break left running ends with the day
    const br = await breakMinutes(u, att.get("id"), now);
    const worked = Math.max(0, Math.round((+now - +new Date(att.get("checkInAt"))) / MIN) - br);
    const sh = await dayPlan(u, e, String(att.get("workDate")).slice(0, 10));
    await u.repo("HrAttendance").updateById(att.get("id"), { checkOutAt: now, workedMinutes: worked, breakMinutes: br, status: worked < sh.halfDay ? "half_day" : att.get("lateMinutes") > 0 ? "late" : "present", ...(o.note?.trim() ? { note: `${att.get("note") ? `${att.get("note")} | ` : ""}${o.note.trim().slice(0, 200)}` } : {}) }, { transaction: u.tx });
    await u.audit({ action: "hr.checked_out", entityType: "hr_attendance", entityId: att.get("id"), after: { workedMinutes: worked, breakMinutes: br } });
    return { state: "done" as const, workedMinutes: worked, breakMinutes: br };
  });
}

/** Who is in right now: one row per active employee with today's state, since when, and how long on break. Poll this for a live view. */
export async function liveBoard(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "hr.read");
  return withUow(sq, ctx, async (u) => {
    const day = dubaiDate(), now = new Date();
    const rows = (await u.sq.query(
      `SELECT e.id, e.full_name AS name, e.employee_no AS no, e.designation, e.department, a.id AS att_id, a.check_in_at AS inAt, a.check_out_at AS outAt, a.status, a.late_minutes AS late, a.worked_minutes AS worked,
              (SELECT b.kind FROM hr_breaks b WHERE b.attendance_id=a.id AND b.tenant_id=a.tenant_id AND b.ended_at IS NULL LIMIT 1) AS breakKind,
              (SELECT b.started_at FROM hr_breaks b WHERE b.attendance_id=a.id AND b.tenant_id=a.tenant_id AND b.ended_at IS NULL LIMIT 1) AS breakStarted,
              (SELECT COUNT(*) FROM hr_leave_requests r WHERE r.tenant_id=e.tenant_id AND r.employee_id=e.id AND r.status='approved' AND :day BETWEEN r.from_date AND r.to_date) AS onLeave,
              (SELECT s.weekly_off FROM hr_shifts s WHERE s.id=e.shift_id AND s.tenant_id=e.tenant_id) AS weeklyOff,
              (SELECT ro.day_off FROM hr_roster ro WHERE ro.employee_id=e.id AND ro.tenant_id=e.tenant_id AND ro.work_date=:day LIMIT 1) AS rosterOff
         FROM hr_employees e LEFT JOIN hr_attendance a ON a.employee_id=e.id AND a.tenant_id=e.tenant_id AND a.work_date=:day
        WHERE e.tenant_id=:t AND e.status <> 'exited' ORDER BY e.full_name`, { replacements: { t: ctx.tenantId, day }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    const holiday: any = await u.repo("HrHoliday").findOne({ where: { onDate: day }, transaction: u.tx });
    const people = rows.map((r) => {
      const off = r.rosterOff != null ? !!Number(r.rosterOff) : (typeof r.weeklyOff === "string" ? JSON.parse(r.weeklyOff) : r.weeklyOff ?? ["sat", "sun"]).includes(dow(day));
      const state: string = r.inAt ? (r.outAt ? "done" : r.breakKind ? "on_break" : "working") : Number(r.onLeave) ? "on_leave" : holiday ? "holiday" : off ? "weekly_off" : "not_in";
      return { id: r.id as string, name: r.name as string, no: r.no as string, designation: r.designation as string | null, department: r.department as string | null, state, checkInAt: r.inAt ? new Date(r.inAt).toISOString() : null, checkOutAt: r.outAt ? new Date(r.outAt).toISOString() : null, late: Number(r.late ?? 0), breakKind: r.breakKind as string | null, breakStartedAt: r.breakStarted ? new Date(r.breakStarted).toISOString() : null, workedMinutes: Number(r.worked ?? 0) };
    });
    const count = (s: string) => people.filter((p) => p.state === s).length;
    return { date: day, serverTime: now.toISOString(), holiday: holiday?.get("name") ?? null, totals: { employees: people.length, working: count("working"), onBreak: count("on_break"), done: count("done"), onLeave: count("on_leave"), notIn: count("not_in"), late: people.filter((p) => p.late > 0).length }, people };
  });
}

/** Daily record for an employee between two dates, with days that have no record shown as absent (unless leave, holiday or weekly off). */
export async function timesheet(sq: Sequelize, ctx: RequestContext, employeeId: string, from: string, to: string) {
  if (!ymd.test(from) || !ymd.test(to) || to < from) throw new ConflictError("Choose a valid date range");
  if (Date.parse(to) - Date.parse(from) > 93 * DAY) throw new ConflictError("Choose at most three months at a time");
  return withUow(sq, ctx, async (u) => {
    const e: any = await u.repo("HrEmployee").findById(employeeId, { transaction: u.tx });
    if (!e) throw new NotFoundError("Employee");
    const mine = e.get("userId") === ctx.userId;
    if (!mine && !hasPermission(ctx, "hr.read")) {
      const me = await selfEmployee(u, ctx);
      if (!me || e.get("managerEmployeeId") !== me.get("id")) throw new NotFoundError("Employee");
    }
    const plan = await planRange(u, e, from, to);
    const att = new Map(((await u.repo("HrAttendance").findAll({ where: { employeeId, workDate: { [Op.between]: [from, to] } }, transaction: u.tx })) as any[]).map((a) => [String(a.get("workDate")), a]));
    const hol = new Map(((await u.repo("HrHoliday").findAll({ where: { onDate: { [Op.between]: [from, to] } }, transaction: u.tx })) as any[]).map((h) => [String(h.get("onDate")), h.get("name") as string]));
    const leaves = (await u.repo("HrLeaveRequest").findAll({ where: { employeeId, status: "approved", fromDate: { [Op.lte]: to }, toDate: { [Op.gte]: from } }, transaction: u.tx })) as any[];
    const today = dubaiDate();
    const days: { date: string; status: string; checkInAt: string | null; checkOutAt: string | null; workedMinutes: number; breakMinutes: number; lateMinutes: number; note: string | null }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const a = att.get(d);
      const onLeave = leaves.some((l) => String(l.get("fromDate")) <= d && String(l.get("toDate")) >= d);
      const status = a?.get("checkInAt") ? (a.get("status") as string) : hol.has(d) ? "holiday" : plan(d).off ? "weekly_off" : onLeave || a?.get("status") === "on_leave" ? "on_leave" : d > today ? "upcoming" : d === today ? "not_in" : "absent";
      days.push({ date: d, status, checkInAt: a?.get("checkInAt") ? new Date(a.get("checkInAt")).toISOString() : null, checkOutAt: a?.get("checkOutAt") ? new Date(a.get("checkOutAt")).toISOString() : null, workedMinutes: Number(a?.get("workedMinutes") ?? 0), breakMinutes: Number(a?.get("breakMinutes") ?? 0), lateMinutes: Number(a?.get("lateMinutes") ?? 0), note: a?.get("note") ?? hol.get(d) ?? null });
    }
    const n = (s: string) => days.filter((d) => d.status === s).length;
    return { employee: { id: employeeId, name: e.get("fullName") as string }, days, summary: { present: n("present") + n("late") + n("half_day"), late: n("late"), halfDays: n("half_day"), absent: n("absent"), onLeave: n("on_leave"), workedHours: Math.round(days.reduce((a, d) => a + d.workedMinutes, 0) / 6) / 10, lateMinutes: days.reduce((a, d) => a + d.lateMinutes, 0) } };
  });
}

/** HR corrects a day (forgotten check-out, wrong time, absent marked by mistake). A reason is required and the old values are kept in the audit trail. */
export async function correctAttendance(sq: Sequelize, ctx: RequestContext, employeeId: string, day: string, o: { checkInAt?: string | null; checkOutAt?: string | null; status?: string; note?: string; reason: string }) {
  authorize(ctx, "hr.attendance.manage");
  if (!ymd.test(day)) throw new ConflictError("Choose a valid date");
  if (!o.reason?.trim()) throw new ConflictError("Say why the record is being corrected");
  return withUow(sq, ctx, async (u) => {
    const e: any = await u.repo("HrEmployee").findById(employeeId, { transaction: u.tx });
    if (!e) throw new NotFoundError("Employee");
    const sh = await dayPlan(u, e, day);
    const cin = o.checkInAt ? new Date(o.checkInAt) : null, cout = o.checkOutAt ? new Date(o.checkOutAt) : null;
    if ((cin && Number.isNaN(+cin)) || (cout && Number.isNaN(+cout))) throw new ConflictError("Invalid time");
    if (cin && cout && cout <= cin) throw new ConflictError("Check-out must be after check-in");
    const row: any = await u.repo("HrAttendance").findOne({ where: { employeeId, workDate: day }, transaction: u.tx });
    const inAt = o.checkInAt === undefined ? (row?.get("checkInAt") ?? null) : cin, outAt = o.checkOutAt === undefined ? (row?.get("checkOutAt") ?? null) : cout;
    const br = row ? await breakMinutes(u, row.get("id"), outAt ? new Date(outAt) : new Date()) : 0;
    const worked = inAt && outAt ? Math.max(0, Math.round((+new Date(outAt) - +new Date(inAt)) / MIN) - br) : 0;
    const late = inAt ? Math.max(0, dubaiMinutes(new Date(inAt)) - (sh.start + sh.grace)) : 0;
    const status = o.status ?? (inAt ? (outAt && worked < sh.halfDay ? "half_day" : late > 0 ? "late" : "present") : "absent");
    const vals = { checkInAt: inAt, checkOutAt: outAt, status, workedMinutes: worked, breakMinutes: br, lateMinutes: late, source: "manual", note: o.note?.trim().slice(0, 300) || row?.get("note") || null, editedBy: ctx.userId };
    const id = row?.get("id") ?? randomUUID();
    if (row) await u.repo("HrAttendance").updateById(id, vals, { transaction: u.tx }); else await u.repo("HrAttendance").create({ id, employeeId, workDate: day, ...vals }, { transaction: u.tx });
    await u.audit({ action: "hr.attendance_corrected", entityType: "hr_attendance", entityId: id, before: row ? { status: row.get("status"), in: row.get("checkInAt"), out: row.get("checkOutAt") } : null, after: { status, in: inAt, out: outAt }, reason: o.reason });
    return plain(await u.repo("HrAttendance").findById(id, { transaction: u.tx }));
  });
}

/** Closes check-ins that were never checked out (earlier days), at the end of that employee's shift, and flags them for HR. */
export async function attendanceCloseSweep(sq: Sequelize, ctx: RequestContext, now = new Date()) {
  return withUow(sq, ctx, async (u) => {
    if (!(await getSetting<boolean>(u.sq, ctx.tenantId, "hr.attendance.auto_close"))) return 0;
    const today = dubaiDate(now);
    const open = (await u.repo("HrAttendance").findAll({ where: { checkInAt: { [Op.ne]: null }, checkOutAt: null, workDate: { [Op.lt]: today } }, limit: 500, transaction: u.tx })) as any[];
    for (const a of open) {
      const e: any = await u.repo("HrEmployee").findById(a.get("employeeId"), { transaction: u.tx });
      const sh = await dayPlan(u, e, String(a.get("workDate")).slice(0, 10));
      const endAt = new Date(new Date(`${a.get("workDate")}T00:00:00Z`).getTime() - 4 * 3_600_000 + sh.end * MIN);
      const outAt = endAt > new Date(a.get("checkInAt")) ? endAt : new Date(new Date(a.get("checkInAt")).getTime() + MIN);
      for (const b of (await u.repo("HrBreak").findAll({ where: { attendanceId: a.get("id"), endedAt: null }, transaction: u.tx })) as any[]) await u.repo("HrBreak").updateById(b.get("id"), { endedAt: outAt > new Date(b.get("startedAt")) ? outAt : new Date(b.get("startedAt")) }, { transaction: u.tx });
      const br = await breakMinutes(u, a.get("id"), outAt);
      const worked = Math.max(0, Math.round((+outAt - +new Date(a.get("checkInAt"))) / MIN) - br);
      await u.repo("HrAttendance").updateById(a.get("id"), { checkOutAt: outAt, workedMinutes: worked, breakMinutes: br, status: worked < sh.halfDay ? "half_day" : a.get("status"), note: `${a.get("note") ? `${a.get("note")} | ` : ""}Auto-closed: no check-out recorded` }, { transaction: u.tx });
    }
    return open.length;
  });
}
