import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize, hasPermission } from "@reales/rbac";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

/**
 * Shift rosters. An employee's shift and weekly days off are the default; a roster row overrides one date with a different shift or a day off, so night
 * shifts, rotations and swapped weekends work. Attendance (late marks, half-day rule, auto-close), timesheets, the live board and payroll all ask here.
 */
const DAY = 86_400_000;
const hhmm = (s: string) => { const [h, m] = s.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const dow = (s: string) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${s}T00:00:00Z`).getUTCDay()]!;
const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const ymd = /^\d{4}-\d{2}-\d{2}$/;

export interface DayPlan { off: boolean; start: number; end: number; grace: number; halfDay: number; fromRoster: boolean }

function planFrom(shift: any | null, rosterRow: any | null, weeklyOff: string[], day: string): DayPlan {
  const s = shift;
  const off = rosterRow ? !!rosterRow.get("dayOff") : weeklyOff.includes(dow(day));
  return { off, start: hhmm(s?.get("startTime") ?? "09:00"), end: hhmm(s?.get("endTime") ?? "18:00"), grace: Number(s?.get("graceMinutes") ?? 10), halfDay: Number(s?.get("halfDayMinutes") ?? 240), fromRoster: !!rosterRow };
}

/** The plan for one employee on one date. */
export async function dayPlan(u: Uow, e: any, day: string): Promise<DayPlan> {
  const r: any = await u.repo("HrRoster").findOne({ where: { employeeId: e.get("id"), workDate: day }, transaction: u.tx });
  const shiftId = r && !r.get("dayOff") && r.get("shiftId") ? r.get("shiftId") : e.get("shiftId");
  const shift: any = shiftId ? await u.repo("HrShift").findById(shiftId, { transaction: u.tx }) : null;
  const base: any = e.get("shiftId") ? (shiftId === e.get("shiftId") ? shift : await u.repo("HrShift").findById(e.get("shiftId"), { transaction: u.tx })) : null;
  return planFrom(shift, r, (base?.get("weeklyOff") as string[] | null) ?? ["sat", "sun"], day);
}

/** Preloads a date range so a month can be planned without a query per day. */
export async function planRange(u: Uow, e: any, from: string, to: string): Promise<(day: string) => DayPlan> {
  const rows = new Map(((await u.repo("HrRoster").findAll({ where: { employeeId: e.get("id"), workDate: { [Op.between]: [from, to] } }, transaction: u.tx })) as any[]).map((r) => [String(r.get("workDate")).slice(0, 10), r]));
  const shifts = new Map(((await u.repo("HrShift").findAll({ transaction: u.tx })) as any[]).map((s) => [s.get("id"), s]));
  const base = e.get("shiftId") ? shifts.get(e.get("shiftId")) : null;
  const weekly = (base?.get("weeklyOff") as string[] | null) ?? ["sat", "sun"];
  return (day) => { const r = rows.get(day); return planFrom(r && !r.get("dayOff") && r.get("shiftId") ? shifts.get(r.get("shiftId")) : base, r ?? null, weekly, day); };
}

export interface RosterInput { employeeIds: string[]; from: string; to: string; shiftId?: string | null; dayOff?: boolean; weekdays?: string[]; note?: string }

/** Puts employees on a shift (or a day off) for a date range, optionally only on certain weekdays. Replaces whatever was rostered on those days. */
export async function setRoster(sq: Sequelize, ctx: RequestContext, i: RosterInput) {
  authorize(ctx, "hr.manage");
  if (!ymd.test(i.from) || !ymd.test(i.to) || i.to < i.from) throw new ConflictError("Choose a valid date range");
  if ((Date.parse(i.to) - Date.parse(i.from)) / DAY > 92) throw new ConflictError("Roster at most three months at a time");
  if (!i.employeeIds.length || i.employeeIds.length > 200) throw new ConflictError("Choose between 1 and 200 employees");
  if (!i.dayOff && !i.shiftId) throw new ConflictError("Choose a shift or mark a day off");
  return withUow(sq, ctx, async (u) => {
    if (i.shiftId && !(await u.repo("HrShift").findById(i.shiftId, { transaction: u.tx }))) throw new NotFoundError("Shift");
    const emps = (await u.repo("HrEmployee").findAll({ where: { id: { [Op.in]: i.employeeIds }, status: { [Op.ne]: "exited" } }, attributes: ["id"], transaction: u.tx })) as any[];
    if (emps.length !== new Set(i.employeeIds).size) throw new NotFoundError("One or more employees");
    let n = 0;
    for (const e of emps) for (let d = i.from; d <= i.to; d = addDays(d, 1)) {
      if (i.weekdays?.length && !i.weekdays.includes(dow(d))) continue;
      const existing: any = await u.repo("HrRoster").findOne({ where: { employeeId: e.get("id"), workDate: d }, transaction: u.tx });
      const vals = { shiftId: i.dayOff ? null : i.shiftId ?? null, dayOff: !!i.dayOff, note: i.note?.trim().slice(0, 200) || null, createdBy: ctx.userId };
      if (existing) await u.repo("HrRoster").updateById(existing.get("id"), vals, { transaction: u.tx }); else await u.repo("HrRoster").create({ id: randomUUID(), employeeId: e.get("id"), workDate: d, ...vals }, { transaction: u.tx });
      n++;
    }
    await u.audit({ action: "hr.roster_set", entityType: "tenant", entityId: ctx.tenantId, after: { employees: emps.length, from: i.from, to: i.to, days: n, dayOff: !!i.dayOff } });
    return { days: n };
  });
}

/** Removes roster overrides so the employees follow their normal shift again. */
export async function clearRoster(sq: Sequelize, ctx: RequestContext, i: { employeeIds: string[]; from: string; to: string }) {
  authorize(ctx, "hr.manage");
  if (!ymd.test(i.from) || !ymd.test(i.to) || i.to < i.from) throw new ConflictError("Choose a valid date range");
  return withUow(sq, ctx, async (u) => {
    const n = await u.repo("HrRoster").deleteWhere({ employeeId: { [Op.in]: i.employeeIds }, workDate: { [Op.between]: [i.from, i.to] } }, { transaction: u.tx });
    await u.audit({ action: "hr.roster_cleared", entityType: "tenant", entityId: ctx.tenantId, after: { rows: n, from: i.from, to: i.to } });
    return { removed: n };
  });
}

/** The roster grid: everyone (hr.read) or just the caller, with each date's effective plan. */
export async function listRoster(sq: Sequelize, ctx: RequestContext, from: string, to: string, mineOnly = false) {
  if (!ymd.test(from) || !ymd.test(to) || to < from || (Date.parse(to) - Date.parse(from)) / DAY > 62) throw new ConflictError("Choose at most two months");
  if (!mineOnly) authorize(ctx, "hr.read");
  return withUow(sq, ctx, async (u) => {
    const where: any = mineOnly || !hasPermission(ctx, "hr.read") ? { userId: ctx.userId } : { status: { [Op.ne]: "exited" } };
    const emps = (await u.repo("HrEmployee").findAll({ where, order: [["fullName", "ASC"]], limit: 300, transaction: u.tx })) as any[];
    const shifts = new Map(((await u.repo("HrShift").findAll({ transaction: u.tx })) as any[]).map((s) => [s.get("id"), s.get("name") as string]));
    const out = [];
    for (const e of emps) {
      const plan = await planRange(u, e, from, to);
      const rows = new Map(((await u.repo("HrRoster").findAll({ where: { employeeId: e.get("id"), workDate: { [Op.between]: [from, to] } }, transaction: u.tx })) as any[]).map((r) => [String(r.get("workDate")).slice(0, 10), r]));
      const days: { date: string; off: boolean; shift: string | null; rostered: boolean; note: string | null }[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) { const p = plan(d), r = rows.get(d); days.push({ date: d, off: p.off, rostered: !!r, shift: p.off ? null : (r?.get("shiftId") ? shifts.get(r.get("shiftId")) ?? null : e.get("shiftId") ? shifts.get(e.get("shiftId")) ?? null : null), note: r?.get("note") ?? null }); }
      out.push({ employeeId: e.get("id") as string, name: e.get("fullName") as string, no: e.get("employeeNo") as string, defaultShift: e.get("shiftId") ? shifts.get(e.get("shiftId")) ?? null : null, days });
    }
    return out;
  });
}
