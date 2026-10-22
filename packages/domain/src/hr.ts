import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { decryptField, encryptField } from "@reales/auth";
import type { RequestContext } from "@reales/database";
import { authorize, can, ForbiddenError, hasPermission } from "@reales/rbac";
import { getSetting } from "./config";
import { nextCounter } from "./finance";
import { notifyUser } from "./notify";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

/* ---------------------------------------------------------------------------------------------- shared helpers */

export const dubaiDate = (d = new Date()) => new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
export const dubaiMinutes = (d: Date) => { const x = new Date(d.getTime() + 4 * 3_600_000); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const DAY = 86_400_000;
const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const dow = (s: string) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${s}T00:00:00Z`).getUTCDay()]!;
const hhmm = (s: string) => { const [h, m] = s.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const mustDate = (s: string, what: string) => { if (!ymd.test(s) || Number.isNaN(Date.parse(s))) throw new ConflictError(`${what} must be a date (YYYY-MM-DD)`); return s; };

export const isHr = (ctx: RequestContext) => hasPermission(ctx, "hr.manage");

/** The employee record linked to the signed-in user, if any. */
export async function selfEmployee(u: Uow, ctx: RequestContext) {
  return (await u.repo("HrEmployee").findOne({ where: { userId: ctx.userId }, transaction: u.tx })) as any | null;
}

async function loadEmployee(u: Uow, id: string) {
  const e: any = await u.repo("HrEmployee").findById(id, { transaction: u.tx });
  if (!e) throw new NotFoundError("Employee");
  return e;
}
/** Employee data is visible to the person themself, to their manager, and to anyone with hr.read. */
async function canSee(u: Uow, ctx: RequestContext, e: any) {
  if (e.get("userId") === ctx.userId || hasPermission(ctx, "hr.read")) return true;
  const me = await selfEmployee(u, ctx);
  return !!me && e.get("managerEmployeeId") === me.get("id");
}
async function assertSee(u: Uow, ctx: RequestContext, e: any) { if (!(await canSee(u, ctx, e))) throw new NotFoundError("Employee"); }

/** Users who hold a permission (for sending HR alerts). */
export async function usersWith(u: Uow, permission: string): Promise<string[]> {
  const rows = (await u.sq.query("SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id AND rp.tenant_id=ur.tenant_id JOIN permissions p ON p.id=rp.permission_id JOIN users us ON us.id=ur.user_id AND us.tenant_id=ur.tenant_id WHERE ur.tenant_id=:t AND p.`key`=:p AND us.status='active'", { replacements: { t: u.tenantId, p: permission }, transaction: u.tx, type: QueryTypes.SELECT })) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/* ---------------------------------------------------------------------------------------------- defaults */

const DEFAULT_LEAVE_TYPES = [
  { code: "ANNUAL", name: "Annual leave", annualDays: 30, accrual: "monthly", carryForwardMax: 5, paid: true, minNoticeDays: 3, color: "#4f46e5", countsWeekends: false },
  { code: "SICK", name: "Sick leave", annualDays: 15, accrual: "upfront", carryForwardMax: 0, paid: true, requiresDocumentAfterDays: 2, color: "#ef4444" },
  { code: "MEDICAL", name: "Medical leave (hospitalisation)", annualDays: 45, accrual: "upfront", carryForwardMax: 0, paid: true, requiresDocumentAfterDays: 1, color: "#f97316" },
  { code: "MATERNITY", name: "Maternity leave", annualDays: 60, accrual: "upfront", carryForwardMax: 0, paid: true, gender: "female", countsWeekends: true, requiresDocumentAfterDays: 1, color: "#ec4899" },
  { code: "PATERNITY", name: "Paternity leave", annualDays: 5, accrual: "upfront", carryForwardMax: 0, paid: true, gender: "male", requiresDocumentAfterDays: 1, color: "#06b6d4" },
  { code: "COMPASSIONATE", name: "Compassionate leave", annualDays: 5, accrual: "upfront", carryForwardMax: 0, paid: true, countsWeekends: true, color: "#64748b" },
  { code: "UNPAID", name: "Unpaid leave", annualDays: 0, accrual: "upfront", carryForwardMax: 0, paid: false, color: "#a3a3a3" },
] as const;

/** First use of HR for a company: standard UAE leave types, a 9-to-6 Monday-Friday shift, and no holidays (the company adds its own). */
export async function ensureHrDefaults(u: Uow) {
  if ((await u.repo("HrLeaveType").count({ transaction: u.tx })) === 0) {
    for (const t of DEFAULT_LEAVE_TYPES) await u.repo("HrLeaveType").create({ id: randomUUID(), maxConsecutiveDays: 0, minServiceMonths: 0, gender: "any", requiresDocumentAfterDays: 0, minNoticeDays: 0, countsWeekends: false, active: true, ...t }, { transaction: u.tx });
  }
  if ((await u.repo("HrShift").count({ transaction: u.tx })) === 0) {
    await u.repo("HrShift").create({ id: randomUUID(), name: "General (9:00-18:00)", startTime: "09:00", endTime: "18:00", breakMinutes: 60, graceMinutes: 10, halfDayMinutes: 240, weeklyOff: ["sat", "sun"], active: true }, { transaction: u.tx });
  }
}

/* ---------------------------------------------------------------------------------------------- employees */

export interface EmployeeInput {
  fullName: string; email?: string | null; phone?: string | null; designation?: string | null; department?: string | null; branchId?: string | null; managerEmployeeId?: string | null; userId?: string | null;
  employmentType?: "full_time" | "part_time" | "contract" | "intern"; joinedOn: string; probationEndsOn?: string | null; dateOfBirth?: string | null; gender?: "male" | "female" | "other" | null;
  nationality?: string | null; workLocation?: string | null; shiftId?: string | null; passportExpiresOn?: string | null; visaExpiresOn?: string | null; emiratesIdExpiresOn?: string | null; labourCardNo?: string | null; notes?: string | null;
  status?: "active" | "on_notice" | "exited"; exitOn?: string | null; exitReason?: string | null;
}
const DATE_FIELDS = ["joinedOn", "probationEndsOn", "dateOfBirth", "passportExpiresOn", "visaExpiresOn", "emiratesIdExpiresOn", "exitOn"] as const;

async function validateEmployee(u: Uow, i: Partial<EmployeeInput>, selfId?: string) {
  for (const f of DATE_FIELDS) if (i[f]) mustDate(i[f]!, f);
  if (i.userId) {
    if (!(await u.repo("User").findById(i.userId, { transaction: u.tx }))) throw new NotFoundError("User");
    const taken: any = await u.repo("HrEmployee").findOne({ where: { userId: i.userId, ...(selfId ? { id: { [Op.ne]: selfId } } : {}) }, transaction: u.tx });
    if (taken) throw new ConflictError("That user is already linked to another employee");
  }
  if (i.managerEmployeeId) {
    if (i.managerEmployeeId === selfId) throw new ConflictError("An employee cannot be their own manager");
    if (!(await u.repo("HrEmployee").findById(i.managerEmployeeId, { transaction: u.tx }))) throw new NotFoundError("Manager");
    // no reporting loops
    let cur: any = await u.repo("HrEmployee").findById(i.managerEmployeeId, { transaction: u.tx }), hops = 0;
    while (cur && selfId && hops++ < 30) { if (cur.get("managerEmployeeId") === selfId) throw new ConflictError("That would create a reporting loop"); cur = cur.get("managerEmployeeId") ? await u.repo("HrEmployee").findById(cur.get("managerEmployeeId"), { transaction: u.tx }) : null; }
  }
  if (i.shiftId && !(await u.repo("HrShift").findById(i.shiftId, { transaction: u.tx }))) throw new NotFoundError("Shift");
  if (i.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email)) throw new ConflictError("Enter a valid e-mail address");
  if (i.fullName !== undefined && !i.fullName.trim()) throw new ConflictError("Name is required");
}

export async function createEmployee(sq: Sequelize, ctx: RequestContext, i: EmployeeInput) {
  authorize(ctx, "hr.manage");
  return withUow(sq, ctx, async (u) => {
    await ensureHrDefaults(u);
    await validateEmployee(u, i);
    const shift = i.shiftId ?? ((await u.repo("HrShift").findOne({ where: { active: true }, order: [["createdAt", "ASC"]], transaction: u.tx })) as any)?.get("id") ?? null;
    const no = `EMP-${String(await nextCounter(u, ctx.tenantId, "hr_employee")).padStart(4, "0")}`;
    const id = randomUUID();
    await u.repo("HrEmployee").create({ id, employeeNo: no, status: "active", employmentType: "full_time", ...i, fullName: i.fullName.trim(), shiftId: shift }, { transaction: u.tx });
    await u.audit({ action: "hr.employee_created", entityType: "hr_employee", entityId: id, after: { employeeNo: no, name: i.fullName.trim() } });
    return plain(await u.repo("HrEmployee").findById(id, { transaction: u.tx }));
  });
}

export async function updateEmployee(sq: Sequelize, ctx: RequestContext, id: string, patch: Partial<EmployeeInput>) {
  authorize(ctx, "hr.manage");
  return withUow(sq, ctx, async (u) => {
    const e = await loadEmployee(u, id);
    await validateEmployee(u, patch, id);
    const next = { ...patch } as Record<string, unknown>;
    if (patch.status === "exited" && !patch.exitOn && !e.get("exitOn")) next.exitOn = dubaiDate();
    await u.repo("HrEmployee").updateById(id, next, { transaction: u.tx });
    await u.audit({ action: patch.status && patch.status !== e.get("status") ? `hr.employee_${patch.status}` : "hr.employee_updated", entityType: "hr_employee", entityId: id, before: { status: e.get("status"), designation: e.get("designation"), department: e.get("department") }, after: { fields: Object.keys(patch) } });
    return plain(await u.repo("HrEmployee").findById(id, { transaction: u.tx }));
  });
}

export async function listEmployees(sq: Sequelize, ctx: RequestContext, f: { q?: string; status?: string; department?: string; limit?: number; offset?: number } = {}) {
  authorize(ctx, "hr.read");
  return withUow(sq, ctx, async (u) => {
    const and: any[] = [];
    if (f.status) and.push({ status: f.status });
    if (f.department) and.push({ department: f.department });
    if (f.q?.trim()) { const like = `%${f.q.trim().replace(/[%_\\]/g, "\\$&")}%`; and.push({ [Op.or]: [{ fullName: { [Op.like]: like } }, { employeeNo: { [Op.like]: like } }, { email: { [Op.like]: like } }, { designation: { [Op.like]: like } }] }); }
    const where = and.length ? { [Op.and]: and } : {};
    const [rows, total] = await Promise.all([
      u.repo("HrEmployee").findAll({ where, order: [["fullName", "ASC"]], limit: Math.min(f.limit ?? 50, 200), offset: f.offset ?? 0, transaction: u.tx }),
      u.repo("HrEmployee").count({ where, transaction: u.tx }),
    ]);
    const depts = (await u.sq.query("SELECT DISTINCT department FROM hr_employees WHERE tenant_id=:t AND department IS NOT NULL ORDER BY department", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT })) as { department: string }[];
    return { rows: rows.map(plain), total: Number(total), departments: depts.map((d) => d.department) };
  });
}

export async function getEmployee(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const e = await loadEmployee(u, id);
    await assertSee(u, ctx, e);
    const shift = e.get("shiftId") ? plain(await u.repo("HrShift").findById(e.get("shiftId"), { transaction: u.tx })) : null;
    const manager = e.get("managerEmployeeId") ? await u.repo("HrEmployee").findById(e.get("managerEmployeeId"), { attributes: ["id", "fullName"], transaction: u.tx }) : null;
    return { ...plain(e), shift, manager: manager ? plain(manager) : null, canSeeSalary: e.get("userId") === ctx.userId || hasPermission(ctx, "hr.salary") };
  });
}

/** The caller's own employee record (null when their login is not linked to one). */
export async function myEmployee(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => { const e = await selfEmployee(u, ctx); return e ? plain(e) : null; });
}

/* ---------------------------------------------------------------------------------------------- shifts and holidays */

export async function listShifts(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => { await ensureHrDefaults(u); return (await u.repo("HrShift").findAll({ order: [["name", "ASC"]], transaction: u.tx })).map(plain); });
}
export async function saveShift(sq: Sequelize, ctx: RequestContext, i: { id?: string; name: string; startTime: string; endTime: string; breakMinutes: number; graceMinutes: number; halfDayMinutes: number; weeklyOff: string[]; active?: boolean }) {
  authorize(ctx, "hr.manage");
  if (!/^\d{2}:\d{2}$/.test(i.startTime) || !/^\d{2}:\d{2}$/.test(i.endTime)) throw new ConflictError("Times must be HH:MM");
  if (hhmm(i.endTime) <= hhmm(i.startTime)) throw new ConflictError("The shift must end after it starts");
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  if (i.weeklyOff.some((d) => !days.includes(d))) throw new ConflictError("Unknown weekday");
  return withUow(sq, ctx, async (u) => {
    const { id, ...rest } = i;
    if (id) { await loadShiftRow(u, id); await u.repo("HrShift").updateById(id, { ...rest, active: i.active ?? true }, { transaction: u.tx }); }
    const sid = id ?? randomUUID();
    if (!id) await u.repo("HrShift").create({ id: sid, ...rest, active: i.active ?? true }, { transaction: u.tx });
    await u.audit({ action: id ? "hr.shift_updated" : "hr.shift_created", entityType: "hr_shift", entityId: sid, after: { name: i.name } });
    return plain(await u.repo("HrShift").findById(sid, { transaction: u.tx }));
  });
}
async function loadShiftRow(u: Uow, id: string) { const s = await u.repo("HrShift").findById(id, { transaction: u.tx }); if (!s) throw new NotFoundError("Shift"); return s; }

export async function listHolidays(sq: Sequelize, ctx: RequestContext, year?: number) {
  return withUow(sq, ctx, async (u) => {
    const y = year ?? Number(dubaiDate().slice(0, 4));
    return (await u.repo("HrHoliday").findAll({ where: { onDate: { [Op.between]: [`${y}-01-01`, `${y}-12-31`] } }, order: [["onDate", "ASC"]], transaction: u.tx })).map(plain);
  });
}
export async function saveHoliday(sq: Sequelize, ctx: RequestContext, i: { onDate: string; name: string }) {
  authorize(ctx, "hr.manage");
  mustDate(i.onDate, "Date");
  return withUow(sq, ctx, async (u) => {
    const existing: any = await u.repo("HrHoliday").findOne({ where: { onDate: i.onDate }, transaction: u.tx });
    if (existing) { await u.repo("HrHoliday").updateById(existing.get("id"), { name: i.name.trim() }, { transaction: u.tx }); return plain(await u.repo("HrHoliday").findById(existing.get("id"), { transaction: u.tx })); }
    const id = randomUUID();
    await u.repo("HrHoliday").create({ id, onDate: i.onDate, name: i.name.trim() }, { transaction: u.tx });
    await u.audit({ action: "hr.holiday_added", entityType: "hr_holiday", entityId: id, after: i });
    return plain(await u.repo("HrHoliday").findById(id, { transaction: u.tx }));
  });
}
export async function deleteHoliday(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.manage");
  return withUow(sq, ctx, async (u) => { if (!(await u.repo("HrHoliday").deleteById(id, { transaction: u.tx }))) throw new NotFoundError("Holiday"); await u.audit({ action: "hr.holiday_removed", entityType: "hr_holiday", entityId: id }); return { id }; });
}

/* ---------------------------------------------------------------------------------------------- salary */

export interface SalaryInput { effectiveFrom: string; currency?: string; basic: number; housing?: number; transport?: number; otherAllowance?: number; components?: { name: string; type: "earning" | "deduction"; amount: number }[]; paymentMethod?: "bank_transfer" | "cash" | "cheque"; iban?: string | null; reason?: string }

export function grossOf(s: { basic: number; housing?: number; transport?: number; otherAllowance?: number; components?: { type: string; amount: number }[] }) {
  const extra = (s.components ?? []).reduce((a, c) => a + (c.type === "deduction" ? -Math.abs(c.amount) : Math.abs(c.amount)), 0);
  return Math.round((s.basic + (s.housing ?? 0) + (s.transport ?? 0) + (s.otherAllowance ?? 0) + extra) * 100) / 100;
}

/** Adds a salary revision. History is kept; the one with the latest effective date on or before today is current. Needs hr.salary. */
export async function setSalary(sq: Sequelize, ctx: RequestContext, employeeId: string, i: SalaryInput) {
  authorize(ctx, "hr.salary");
  mustDate(i.effectiveFrom, "Effective date");
  for (const [k, v] of Object.entries({ basic: i.basic, housing: i.housing ?? 0, transport: i.transport ?? 0, otherAllowance: i.otherAllowance ?? 0 })) if (!(v >= 0) || !Number.isFinite(v)) throw new ConflictError(`${k} must be zero or more`);
  if (!(i.basic > 0)) throw new ConflictError("Basic salary must be above zero");
  return withUow(sq, ctx, async (u) => {
    await loadEmployee(u, employeeId);
    const prev: any = await currentSalaryRow(u, employeeId);
    const gross = grossOf(i);
    if (gross <= 0) throw new ConflictError("Gross salary must be above zero");
    const id = randomUUID();
    await u.repo("HrSalary").create({ id, employeeId, effectiveFrom: i.effectiveFrom, currency: (i.currency ?? "AED").toUpperCase(), basic: i.basic, housing: i.housing ?? 0, transport: i.transport ?? 0, otherAllowance: i.otherAllowance ?? 0, components: i.components ?? [], gross, paymentMethod: i.paymentMethod ?? "bank_transfer", ibanEnc: i.iban?.trim() ? encryptField(i.iban.trim().replace(/\s+/g, "").toUpperCase()) : (prev?.get("ibanEnc") ?? null), reason: i.reason?.slice(0, 200) ?? null, createdBy: ctx.userId }, { transaction: u.tx });
    // The audit trail records that pay changed and by how much in total, not the breakdown or the bank account.
    await u.audit({ action: "hr.salary_changed", entityType: "hr_employee", entityId: employeeId, before: { gross: prev ? Number(prev.get("gross")) : null }, after: { gross, effectiveFrom: i.effectiveFrom }, reason: i.reason });
    return salaryView(await u.repo("HrSalary").findById(id, { transaction: u.tx }), true);
  });
}

async function currentSalaryRow(u: Uow, employeeId: string, on = dubaiDate()) {
  return (await u.repo("HrSalary").findOne({ where: { employeeId, effectiveFrom: { [Op.lte]: on } }, order: [["effectiveFrom", "DESC"], ["createdAt", "DESC"]], transaction: u.tx })) as any | null;
}
function salaryView(r: any, showIban: boolean) {
  const iban = r.get("ibanEnc") ? decryptField(r.get("ibanEnc")) : null;
  const p = plain(r); delete p.ibanEnc;
  return { ...p, basic: Number(p.basic), housing: Number(p.housing), transport: Number(p.transport), otherAllowance: Number(p.otherAllowance), gross: Number(p.gross), iban: iban ? (showIban ? iban : `****${iban.slice(-4)}`) : null };
}

/** Salary history, newest first. The employee sees their own; everyone else needs hr.salary. */
export async function getSalaryHistory(sq: Sequelize, ctx: RequestContext, employeeId: string) {
  return withUow(sq, ctx, async (u) => {
    const e = await loadEmployee(u, employeeId);
    if (e.get("userId") !== ctx.userId) authorize(ctx, "hr.salary");
    const rows = (await u.repo("HrSalary").findAll({ where: { employeeId }, order: [["effectiveFrom", "DESC"], ["createdAt", "DESC"]], transaction: u.tx })) as any[];
    const current = await currentSalaryRow(u, employeeId);
    return rows.map((r) => ({ ...salaryView(r, can(ctx, "hr.salary")), current: !!current && r.get("id") === current.get("id") }));
  });
}
export async function currentSalaryFor(u: Uow, employeeId: string) { const r = await currentSalaryRow(u, employeeId); return r ? salaryView(r, false) : null; }

/* ---------------------------------------------------------------------------------------------- leave types, balances */

export async function listLeaveTypes(sq: Sequelize, ctx: RequestContext, all = false) {
  return withUow(sq, ctx, async (u) => {
    await ensureHrDefaults(u);
    return (await u.repo("HrLeaveType").findAll({ where: all ? {} : { active: true }, order: [["name", "ASC"]], transaction: u.tx })).map((t: any) => ({ ...plain(t), annualDays: Number(t.get("annualDays")), carryForwardMax: Number(t.get("carryForwardMax")) }));
  });
}
export interface LeaveTypeInput { id?: string; code: string; name: string; annualDays: number; accrual: "upfront" | "monthly"; carryForwardMax: number; paid: boolean; requiresDocumentAfterDays: number; maxConsecutiveDays: number; minNoticeDays: number; gender: "any" | "male" | "female"; countsWeekends: boolean; minServiceMonths: number; active: boolean; color?: string | null }
export async function saveLeaveType(sq: Sequelize, ctx: RequestContext, i: LeaveTypeInput) {
  authorize(ctx, "hr.manage");
  if (!/^[A-Z0-9_]{2,30}$/.test(i.code)) throw new ConflictError("Code is capitals, digits and underscores, for example ANNUAL");
  if (i.annualDays < 0 || i.carryForwardMax < 0) throw new ConflictError("Days cannot be negative");
  return withUow(sq, ctx, async (u) => {
    const clash: any = await u.repo("HrLeaveType").findOne({ where: { code: i.code, ...(i.id ? { id: { [Op.ne]: i.id } } : {}) }, transaction: u.tx });
    if (clash) throw new ConflictError("That code is already used");
    const { id, ...rest } = i;
    if (id) { if (!(await u.repo("HrLeaveType").updateById(id, rest, { transaction: u.tx }))) throw new NotFoundError("Leave type"); }
    const tid = id ?? randomUUID();
    if (!id) await u.repo("HrLeaveType").create({ id: tid, ...rest }, { transaction: u.tx });
    await u.audit({ action: id ? "hr.leave_type_updated" : "hr.leave_type_created", entityType: "hr_leave_type", entityId: tid, after: { code: i.code, annualDays: i.annualDays } });
    return plain(await u.repo("HrLeaveType").findById(tid, { transaction: u.tx }));
  });
}

/** Whole-day count of a leave, skipping the employee's weekly off days and public holidays unless the type counts them. */
export function leaveDays(from: string, to: string, half: string, o: { weeklyOff: string[]; holidays: Set<string>; countsWeekends: boolean }) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) { if (!o.countsWeekends && (o.weeklyOff.includes(dow(d)) || o.holidays.has(d))) continue; n++; }
  return half !== "none" && n > 0 ? n - 0.5 : n;
}

async function employeeContext(u: Uow, e: any) {
  const shift: any = e.get("shiftId") ? await u.repo("HrShift").findById(e.get("shiftId"), { transaction: u.tx }) : null;
  return { weeklyOff: (shift?.get("weeklyOff") as string[] | null) ?? ["sat", "sun"], shift };
}
async function holidaySet(u: Uow, from: string, to: string) {
  return new Set(((await u.repo("HrHoliday").findAll({ where: { onDate: { [Op.between]: [from, to] } }, transaction: u.tx })) as any[]).map((h) => String(h.get("onDate"))));
}

async function balanceFor(u: Uow, e: any, t: any, year: number) {
  const today = dubaiDate(), joined = String(e.get("joinedOn"));
  const annual = Number(t.get("annualDays")), unlimited = annual === 0 && !t.get("paid");
  let entitled = annual;
  if (t.get("accrual") === "monthly") {
    const startMonth = joined.startsWith(String(year)) ? Number(joined.slice(5, 7)) - 1 : 0;
    const endMonth = today.startsWith(String(year)) ? Number(today.slice(5, 7)) : 12;
    entitled = Math.round(((annual * Math.max(0, endMonth - startMonth)) / 12) * 2) / 2;
  }
  const row: any = await u.repo("HrLeaveBalance").findOne({ where: { employeeId: e.get("id"), leaveTypeId: t.get("id"), year }, transaction: u.tx });
  const carried = row ? Number(row.get("carried")) : 0, adjusted = row ? Number(row.get("adjusted")) : 0;
  const used = (await u.sq.query("SELECT status, COALESCE(SUM(days),0) AS d FROM hr_leave_requests WHERE tenant_id=:t AND employee_id=:e AND leave_type_id=:lt AND status IN ('approved','pending') AND from_date BETWEEN :a AND :b GROUP BY status", { replacements: { t: u.tenantId, e: e.get("id"), lt: t.get("id"), a: `${year}-01-01`, b: `${year}-12-31` }, transaction: u.tx, type: QueryTypes.SELECT })) as { status: string; d: string }[];
  const taken = Number(used.find((x) => x.status === "approved")?.d ?? 0), pending = Number(used.find((x) => x.status === "pending")?.d ?? 0);
  return { leaveTypeId: t.get("id") as string, code: t.get("code") as string, name: t.get("name") as string, color: t.get("color") as string | null, paid: !!t.get("paid"), unlimited, entitled: unlimited ? 0 : entitled, carried, adjusted, taken, pending, available: unlimited ? null : Math.round((entitled + carried + adjusted - taken - pending) * 10) / 10 };
}

export async function getLeaveBalances(sq: Sequelize, ctx: RequestContext, employeeId: string, year?: number) {
  return withUow(sq, ctx, async (u) => {
    await ensureHrDefaults(u);
    const e = await loadEmployee(u, employeeId);
    await assertSee(u, ctx, e);
    const types = (await u.repo("HrLeaveType").findAll({ where: { active: true }, order: [["name", "ASC"]], transaction: u.tx })) as any[];
    const y = year ?? Number(dubaiDate().slice(0, 4));
    const gender = e.get("gender");
    return Promise.all(types.filter((t) => t.get("gender") === "any" || !gender || t.get("gender") === gender).map((t) => balanceFor(u, e, t, y)));
  });
}

export async function adjustLeaveBalance(sq: Sequelize, ctx: RequestContext, employeeId: string, leaveTypeId: string, year: number, o: { adjusted?: number; carried?: number; note?: string }) {
  authorize(ctx, "hr.manage");
  if (!o.note?.trim()) throw new ConflictError("Say why the balance is being changed");
  return withUow(sq, ctx, async (u) => {
    await loadEmployee(u, employeeId);
    if (!(await u.repo("HrLeaveType").findById(leaveTypeId, { transaction: u.tx }))) throw new NotFoundError("Leave type");
    const row: any = await u.repo("HrLeaveBalance").findOne({ where: { employeeId, leaveTypeId, year }, transaction: u.tx });
    const vals = { ...(o.adjusted !== undefined ? { adjusted: o.adjusted } : {}), ...(o.carried !== undefined ? { carried: o.carried } : {}), note: (o.note ?? "").trim().slice(0, 200) };
    if (row) await u.repo("HrLeaveBalance").updateById(row.get("id"), vals, { transaction: u.tx });
    else await u.repo("HrLeaveBalance").create({ id: randomUUID(), employeeId, leaveTypeId, year, entitled: 0, carried: 0, adjusted: 0, ...vals }, { transaction: u.tx });
    await u.audit({ action: "hr.leave_balance_adjusted", entityType: "hr_employee", entityId: employeeId, after: { leaveTypeId, year, ...vals }, reason: o.note });
    return { ok: true };
  });
}

/** At year end: unused days of each type roll into next year, up to the type's carry-forward limit. Safe to run twice (it sets, not adds). */
export async function carryForwardLeave(sq: Sequelize, ctx: RequestContext, fromYear: number) {
  authorize(ctx, "hr.manage");
  return withUow(sq, ctx, async (u) => {
    const emps = (await u.repo("HrEmployee").findAll({ where: { status: { [Op.ne]: "exited" } }, transaction: u.tx })) as any[];
    const types = (await u.repo("HrLeaveType").findAll({ where: { active: true, carryForwardMax: { [Op.gt]: 0 } }, transaction: u.tx })) as any[];
    let n = 0;
    for (const e of emps) for (const t of types) {
      const b = await balanceFor(u, e, t, fromYear);
      const carry = Math.max(0, Math.min(Number(t.get("carryForwardMax")), b.available ?? 0));
      const row: any = await u.repo("HrLeaveBalance").findOne({ where: { employeeId: e.get("id"), leaveTypeId: t.get("id"), year: fromYear + 1 }, transaction: u.tx });
      if (row) await u.repo("HrLeaveBalance").updateById(row.get("id"), { carried: carry }, { transaction: u.tx });
      else await u.repo("HrLeaveBalance").create({ id: randomUUID(), employeeId: e.get("id"), leaveTypeId: t.get("id"), year: fromYear + 1, entitled: 0, carried: carry, adjusted: 0 }, { transaction: u.tx });
      n++;
    }
    await u.audit({ action: "hr.leave_carried_forward", entityType: "tenant", entityId: ctx.tenantId, after: { fromYear, rows: n } });
    return { rows: n };
  });
}

/* ---------------------------------------------------------------------------------------------- leave requests */

export interface LeaveRequestInput { employeeId?: string; leaveTypeId: string; fromDate: string; toDate: string; halfDay?: "none" | "first" | "second"; reason?: string }

/** Employees request for themselves; HR may request on someone's behalf. Every rule of the leave type is checked before anything is saved. */
export async function requestLeave(sq: Sequelize, ctx: RequestContext, i: LeaveRequestInput) {
  mustDate(i.fromDate, "From date"); mustDate(i.toDate, "To date");
  if (i.toDate < i.fromDate) throw new ConflictError("The end date is before the start date");
  const half = i.halfDay ?? "none";
  if (half !== "none" && i.fromDate !== i.toDate) throw new ConflictError("A half day must be a single day");
  return withUow(sq, ctx, async (u) => {
    await ensureHrDefaults(u);
    const me = await selfEmployee(u, ctx);
    const e = i.employeeId && i.employeeId !== me?.get("id") ? await loadEmployee(u, i.employeeId) : me;
    if (!e) throw new ConflictError("Your login is not linked to an employee record. Ask HR.");
    if (e !== me) authorize(ctx, "hr.manage");
    if (e.get("status") === "exited") throw new ConflictError("This employee has left");
    const t: any = await u.repo("HrLeaveType").findOne({ where: { id: i.leaveTypeId, active: true }, transaction: u.tx });
    if (!t) throw new NotFoundError("Leave type");
    if (t.get("gender") !== "any" && e.get("gender") && t.get("gender") !== e.get("gender")) throw new ConflictError(`${t.get("name")} does not apply to this employee`);
    const monthsService = (Date.now() - Date.parse(String(e.get("joinedOn")))) / (30.44 * DAY);
    if (Number(t.get("minServiceMonths")) > monthsService) throw new ConflictError(`${t.get("name")} needs ${t.get("minServiceMonths")} months of service`);
    const today = dubaiDate();
    if (e === me && i.fromDate < addDays(today, Number(t.get("minNoticeDays")))  && t.get("minNoticeDays") > 0 && i.fromDate >= today) throw new ConflictError(`${t.get("name")} needs ${t.get("minNoticeDays")} days notice`);
    const { weeklyOff } = await employeeContext(u, e);
    const days = leaveDays(i.fromDate, i.toDate, half, { weeklyOff, holidays: await holidaySet(u, i.fromDate, i.toDate), countsWeekends: !!t.get("countsWeekends") });
    if (days <= 0) throw new ConflictError("Those dates are all days off, so no leave is needed");
    const maxRun = Number(t.get("maxConsecutiveDays"));
    if (maxRun > 0 && days > maxRun) throw new ConflictError(`${t.get("name")} is limited to ${maxRun} days at a time`);
    const overlap: any = await u.repo("HrLeaveRequest").findOne({ where: { employeeId: e.get("id"), status: { [Op.in]: ["pending", "approved"] }, fromDate: { [Op.lte]: i.toDate }, toDate: { [Op.gte]: i.fromDate } }, transaction: u.tx });
    if (overlap) throw new ConflictError(`There is already a ${overlap.get("status")} leave request from ${overlap.get("fromDate")} to ${overlap.get("toDate")}`);
    const year = Number(i.fromDate.slice(0, 4));
    const bal = await balanceFor(u, e, t, year);
    if (!bal.unlimited && (bal.available ?? 0) < days && !(await getSetting<boolean>(u.sq, ctx.tenantId, "hr.leave.allow_negative_balance"))) throw new ConflictError(`Only ${bal.available} day(s) of ${t.get("name")} left, and this needs ${days}`);
    const id = randomUUID();
    await u.repo("HrLeaveRequest").create({ id, employeeId: e.get("id"), leaveTypeId: t.get("id"), fromDate: i.fromDate, toDate: i.toDate, halfDay: half, days, reason: i.reason?.trim().slice(0, 500) || null, status: "pending" }, { transaction: u.tx });
    await u.audit({ action: "hr.leave_requested", entityType: "hr_leave_request", entityId: id, after: { employee: e.get("employeeNo"), type: t.get("code"), from: i.fromDate, to: i.toDate, days } });
    // tell the manager, or HR when there is no manager
    const mgr: any = e.get("managerEmployeeId") ? await u.repo("HrEmployee").findById(e.get("managerEmployeeId"), { transaction: u.tx }) : null;
    const approvers = mgr?.get("userId") ? [mgr.get("userId") as string] : await usersWith(u, "hr.leave.approve");
    for (const a of approvers) if (a !== ctx.userId) await notifyUser(u, { userId: a, kind: "hr.leave_requested", title: `${e.get("fullName")} requested ${days} day(s) of ${t.get("name")}`, body: `${i.fromDate} to ${i.toDate}`, entityType: "hr_leave_request", entityId: id, dedupeKey: `leave.req:${id}:${a}`, path: "/hr/leave" });
    return plain(await u.repo("HrLeaveRequest").findById(id, { transaction: u.tx }));
  });
}

async function mayDecide(u: Uow, ctx: RequestContext, e: any) {
  if (e.get("userId") === ctx.userId) return false; // never your own leave
  if (hasPermission(ctx, "hr.leave.approve")) return true;
  const me = await selfEmployee(u, ctx);
  return !!me && e.get("managerEmployeeId") === me.get("id");
}

/** Approve or reject. Approval marks the days as leave in attendance. Only the employee's manager or an HR approver can decide, never the employee. */
export async function decideLeave(sq: Sequelize, ctx: RequestContext, id: string, o: { approve: boolean; note?: string }) {
  if (!o.approve && !o.note?.trim()) throw new ConflictError("Give a reason when rejecting");
  return withUow(sq, ctx, async (u) => {
    const r: any = await u.repo("HrLeaveRequest").findById(id, { transaction: u.tx });
    if (!r) throw new NotFoundError("Leave request");
    const e = await loadEmployee(u, r.get("employeeId"));
    if (!(await mayDecide(u, ctx, e))) throw new ForbiddenError("Only the employee's manager or HR can decide this, and nobody decides their own leave");
    if (r.get("status") !== "pending") throw new ConflictError(`This request is already ${r.get("status")}`);
    if (o.approve) {
      const t: any = await u.repo("HrLeaveType").findById(r.get("leaveTypeId"), { transaction: u.tx });
      const bal = await balanceFor(u, e, t, Number(String(r.get("fromDate")).slice(0, 4)));
      if (!bal.unlimited && (bal.available ?? 0) + Number(r.get("days")) < Number(r.get("days")) && !(await getSetting<boolean>(u.sq, ctx.tenantId, "hr.leave.allow_negative_balance"))) throw new ConflictError("The balance no longer covers this leave");
    }
    await u.repo("HrLeaveRequest").updateById(id, { status: o.approve ? "approved" : "rejected", approverUserId: ctx.userId, decidedAt: new Date(), decisionNote: o.note?.trim().slice(0, 300) || null }, { transaction: u.tx });
    if (o.approve) await markLeaveInAttendance(u, e, String(r.get("fromDate")), String(r.get("toDate")));
    await u.audit({ action: o.approve ? "hr.leave_approved" : "hr.leave_rejected", entityType: "hr_leave_request", entityId: id, after: { employee: e.get("employeeNo"), days: Number(r.get("days")) }, reason: o.note });
    if (e.get("userId")) await notifyUser(u, { userId: e.get("userId"), kind: o.approve ? "hr.leave_approved" : "hr.leave_rejected", title: `Your leave request was ${o.approve ? "approved" : "rejected"}`, body: `${r.get("fromDate")} to ${r.get("toDate")}${o.note ? `: ${o.note}` : ""}`, entityType: "hr_leave_request", entityId: id, dedupeKey: `leave.dec:${id}`, path: "/hr/leave" });
    return plain(await u.repo("HrLeaveRequest").findById(id, { transaction: u.tx }));
  });
}

async function markLeaveInAttendance(u: Uow, e: any, from: string, to: string) {
  const { weeklyOff } = await employeeContext(u, e);
  const holidays = await holidaySet(u, from, to);
  for (let d = from; d <= to && d < addDays(dubaiDate(), 400); d = addDays(d, 1)) {
    if (weeklyOff.includes(dow(d)) || holidays.has(d)) continue;
    const row: any = await u.repo("HrAttendance").findOne({ where: { employeeId: e.get("id"), workDate: d }, transaction: u.tx });
    if (!row) await u.repo("HrAttendance").create({ id: randomUUID(), employeeId: e.get("id"), workDate: d, status: "on_leave", workedMinutes: 0, breakMinutes: 0, lateMinutes: 0, source: "manual", note: "Approved leave" }, { transaction: u.tx });
  }
}

export async function cancelLeave(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const r: any = await u.repo("HrLeaveRequest").findById(id, { transaction: u.tx });
    if (!r) throw new NotFoundError("Leave request");
    const e = await loadEmployee(u, r.get("employeeId"));
    if (e.get("userId") !== ctx.userId) authorize(ctx, "hr.manage");
    if (!["pending", "approved"].includes(r.get("status"))) throw new ConflictError(`This request is already ${r.get("status")}`);
    if (r.get("status") === "approved" && String(r.get("fromDate")) < dubaiDate() && !hasPermission(ctx, "hr.manage")) throw new ConflictError("Leave that has already started can only be cancelled by HR");
    await u.repo("HrLeaveRequest").updateById(id, { status: "cancelled" }, { transaction: u.tx });
    await u.sq.query("DELETE FROM hr_attendance WHERE tenant_id=:t AND employee_id=:e AND status='on_leave' AND work_date BETWEEN :a AND :b AND check_in_at IS NULL AND source='manual' AND note='Approved leave'", { replacements: { t: ctx.tenantId, e: e.get("id"), a: r.get("fromDate"), b: r.get("toDate") }, transaction: u.tx });
    await u.audit({ action: "hr.leave_cancelled", entityType: "hr_leave_request", entityId: id });
    return plain(await u.repo("HrLeaveRequest").findById(id, { transaction: u.tx }));
  });
}

export async function listLeaveRequests(sq: Sequelize, ctx: RequestContext, f: { scope: "mine" | "team" | "all"; status?: string; limit?: number } = { scope: "mine" }) {
  return withUow(sq, ctx, async (u) => {
    const me = await selfEmployee(u, ctx);
    const and: any[] = [];
    if (f.status) and.push({ status: f.status });
    if (f.scope === "mine") and.push({ employeeId: me?.get("id") ?? "-" });
    else if (f.scope === "team" && !hasPermission(ctx, "hr.leave.approve")) {
      const reports = me ? ((await u.repo("HrEmployee").findAll({ where: { managerEmployeeId: me.get("id") }, attributes: ["id"], transaction: u.tx })) as any[]).map((r) => r.get("id")) : [];
      and.push({ employeeId: { [Op.in]: reports.length ? reports : ["-"] } });
    } else if (f.scope === "all") authorize(ctx, "hr.read");
    const rows = (await u.repo("HrLeaveRequest").findAll({ where: and.length ? { [Op.and]: and } : {}, order: [["createdAt", "DESC"]], limit: Math.min(f.limit ?? 100, 300), transaction: u.tx })) as any[];
    const emps = new Map(((await u.repo("HrEmployee").findAll({ where: { id: { [Op.in]: [...new Set(rows.map((r) => r.get("employeeId")))].concat(["-"]) } }, attributes: ["id", "fullName", "employeeNo", "userId"], transaction: u.tx })) as any[]).map((x) => [x.get("id"), x]));
    const types = new Map(((await u.repo("HrLeaveType").findAll({ transaction: u.tx })) as any[]).map((t) => [t.get("id"), t]));
    return Promise.all(rows.map(async (r) => { const e = emps.get(r.get("employeeId")); const full = e ? await loadEmployee(u, e.get("id")) : null; return { ...plain(r), days: Number(r.get("days")), employeeName: e?.get("fullName") ?? "", employeeNo: e?.get("employeeNo") ?? "", typeName: types.get(r.get("leaveTypeId"))?.get("name") ?? "", typeColor: types.get(r.get("leaveTypeId"))?.get("color") ?? null, canDecide: r.get("status") === "pending" && !!full && (await mayDecide(u, ctx, full)), canCancel: ["pending", "approved"].includes(r.get("status")) && (e?.get("userId") === ctx.userId || hasPermission(ctx, "hr.manage")) }; }));
  });
}

/** Approved leave in a date range for the team calendar (names and dates only). */
export async function leaveCalendar(sq: Sequelize, ctx: RequestContext, from: string, to: string) {
  authorize(ctx, "hr.read");
  mustDate(from, "From"); mustDate(to, "To");
  return withUow(sq, ctx, async (u) => (await u.sq.query("SELECT r.from_date AS fromDate, r.to_date AS toDate, r.days, e.full_name AS name, t.name AS type, t.color FROM hr_leave_requests r JOIN hr_employees e ON e.id=r.employee_id AND e.tenant_id=r.tenant_id JOIN hr_leave_types t ON t.id=r.leave_type_id AND t.tenant_id=r.tenant_id WHERE r.tenant_id=:t AND r.status='approved' AND r.from_date <= :to AND r.to_date >= :from ORDER BY r.from_date", { replacements: { t: ctx.tenantId, from, to }, transaction: u.tx, type: QueryTypes.SELECT })) as any[]);
}
