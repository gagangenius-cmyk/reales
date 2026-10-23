import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { decryptField } from "@reales/auth";
import type { RequestContext } from "@reales/database";
import { authorize, hasPermission } from "@reales/rbac";
import { getSetting } from "./config";
import { nextCounter } from "./finance";
import { dubaiDate, leaveDays, selfEmployee } from "./hr";
import { planRange } from "./hr-roster";
import { notifyUser } from "./notify";
import { renderPdf } from "./pdf";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

/**
 * Monthly payroll. A run is built from each employee's salary in force at month end, prorated for part-month joiners and leavers, less unpaid leave and
 * (when the company wants it) unexplained absence at gross / 30 per day. HR can add one-off earnings or deductions with a reason while the run is a draft.
 * Approving numbers and freezes the payslips; marking the run paid makes them visible to the employees. This prepares pay; it does not move money, and the
 * bank file is a plain CSV for the company's bank upload, not an official WPS SIF file.
 */
const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const dow = (s: string) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${s}T00:00:00Z`).getUTCDay()]!;
const monthEnd = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
const days = (a: string, b: string) => (b < a ? 0 : Math.round((Date.parse(b) - Date.parse(a)) / DAY) + 1);
type Line = { name: string; amount: number; manual?: boolean; reason?: string };

async function build(u: Uow, ctx: RequestContext, e: any, period: string): Promise<Record<string, unknown> | null> {
  const start = `${period}-01`, end = monthEnd(period), inPeriod = days(start, end);
  const joined = String(e.get("joinedOn")).slice(0, 10), exit = e.get("exitOn") ? String(e.get("exitOn")).slice(0, 10) : null;
  const from = joined > start ? joined : start, to = exit && exit < end ? exit : end;
  if (to < from) return null;
  const sal: any = await u.repo("HrSalary").findOne({ where: { employeeId: e.get("id"), effectiveFrom: { [Op.lte]: end } }, order: [["effectiveFrom", "DESC"], ["createdAt", "DESC"]], transaction: u.tx });
  if (!sal) return null;
  const factor = days(from, to) / inPeriod;
  const part = (v: unknown) => r2(Number(v) * factor);
  const basic = part(sal.get("basic")), housing = part(sal.get("housing")), transport = part(sal.get("transport")), other = part(sal.get("otherAllowance"));
  const gross0 = r2(Number(sal.get("gross")) * factor), daily = Number(sal.get("gross")) / 30;
  const shift: any = e.get("shiftId") ? await u.repo("HrShift").findById(e.get("shiftId"), { transaction: u.tx }) : null;
  const weeklyOff: string[] = shift?.get("weeklyOff") ?? ["sat", "sun"];
  const plan = await planRange(u, e, from, to);
  const holidays = new Set(((await u.repo("HrHoliday").findAll({ where: { onDate: { [Op.between]: [from, to] } }, transaction: u.tx })) as any[]).map((h) => String(h.get("onDate")).slice(0, 10)));
  const leaves = (await u.repo("HrLeaveRequest").findAll({ where: { employeeId: e.get("id"), status: "approved", fromDate: { [Op.lte]: to }, toDate: { [Op.gte]: from } }, transaction: u.tx })) as any[];
  const types = new Map(((await u.repo("HrLeaveType").findAll({ transaction: u.tx })) as any[]).map((t) => [t.get("id"), t]));
  let unpaid = 0;
  const onLeave = new Set<string>();
  for (const l of leaves) {
    const t = types.get(l.get("leaveTypeId"));
    const a = String(l.get("fromDate")).slice(0, 10) > from ? String(l.get("fromDate")).slice(0, 10) : from, b = String(l.get("toDate")).slice(0, 10) < to ? String(l.get("toDate")).slice(0, 10) : to;
    for (let d = a; d <= b; d = addDays(d, 1)) onLeave.add(d);
    if (t && !t.get("paid")) unpaid += leaveDays(a, b, a === b ? l.get("halfDay") : "none", { weeklyOff, holidays, countsWeekends: !!t.get("countsWeekends") });
  }
  let absent = 0;
  if (await getSetting<boolean>(u.sq, ctx.tenantId, "hr.payroll.deduct_absence")) {
    const last = addDays(dubaiDate(), -1) < to ? addDays(dubaiDate(), -1) : to;
    const present = new Set(((await u.sq.query("SELECT work_date FROM hr_attendance WHERE tenant_id=:t AND employee_id=:e AND work_date BETWEEN :a AND :b AND check_in_at IS NOT NULL", { replacements: { t: ctx.tenantId, e: e.get("id"), a: from, b: to }, transaction: u.tx, type: QueryTypes.SELECT })) as { work_date: string }[]).map((r) => String(r.work_date).slice(0, 10)));
    for (let d = from; d <= last; d = addDays(d, 1)) if (!plan(d).off && !holidays.has(d) && !onLeave.has(d) && !present.has(d)) absent++;
  }
  const deductions: Line[] = [];
  const earnings: Line[] = [];
  for (const x of (await u.repo("HrEncashment").findAll({ where: { employeeId: e.get("id"), status: "pending" }, transaction: u.tx })) as any[]) earnings.push({ name: `Leave encashment (${Number(x.get("days"))} day${Number(x.get("days")) === 1 ? "" : "s"})`, amount: Number(x.get("amount")) });
  if (unpaid > 0) deductions.push({ name: `Unpaid leave (${unpaid} day${unpaid === 1 ? "" : "s"})`, amount: r2(unpaid * daily) });
  if (absent > 0) deductions.push({ name: `Absence (${absent} day${absent === 1 ? "" : "s"})`, amount: r2(absent * daily) });
  return { currency: sal.get("currency"), daysInPeriod: inPeriod, daysPayable: days(from, to), unpaidDays: unpaid, absentDays: absent, basic, housing, transport, otherAllowance: other, grossBase: gross0, deductions, earnings };
}

function totals(p: { basic: number; housing: number; transport: number; otherAllowance: number }, earnings: Line[], deductions: Line[]) {
  const gross = r2(p.basic + p.housing + p.transport + p.otherAllowance + earnings.reduce((a, x) => a + x.amount, 0));
  const ded = r2(deductions.reduce((a, x) => a + x.amount, 0));
  return { gross, deductionsTotal: ded, net: r2(Math.max(0, gross - ded)) };
}

async function sumRun(u: Uow, runId: string) {
  const ps = (await u.repo("HrPayslip").findAll({ where: { runId }, transaction: u.tx })) as any[];
  await u.repo("HrPayrollRun").updateById(runId, { employeesCount: ps.length, totalGross: r2(ps.reduce((a, p) => a + Number(p.get("gross")), 0)), totalDeductions: r2(ps.reduce((a, p) => a + Number(p.get("deductionsTotal")), 0)), totalNet: r2(ps.reduce((a, p) => a + Number(p.get("net")), 0)) }, { transaction: u.tx });
}

export async function createPayrollRun(sq: Sequelize, ctx: RequestContext, period: string) {
  authorize(ctx, "hr.salary");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ConflictError("Choose a month like 2026-10");
  if (period > dubaiDate().slice(0, 7)) throw new ConflictError("Payroll cannot be run for a future month");
  return withUow(sq, ctx, async (u) => {
    if (await u.repo("HrPayrollRun").findOne({ where: { period }, transaction: u.tx })) throw new ConflictError(`Payroll for ${period} already exists`);
    const runId = randomUUID();
    await u.repo("HrPayrollRun").create({ id: runId, period, status: "draft", createdBy: ctx.userId, employeesCount: 0, totalGross: 0, totalDeductions: 0, totalNet: 0 }, { transaction: u.tx });
    const emps = (await u.repo("HrEmployee").findAll({ where: { joinedOn: { [Op.lte]: monthEnd(period) } }, order: [["fullName", "ASC"]], transaction: u.tx })) as any[];
    const skipped: { name: string; why: string }[] = [];
    for (const e of emps) {
      const b: any = await build(u, ctx, e, period);
      if (!b) { if (!e.get("exitOn") || String(e.get("exitOn")).slice(0, 10) >= `${period}-01`) skipped.push({ name: e.get("fullName"), why: "no salary set" }); continue; }
      const t = totals(b, b.earnings, b.deductions);
      await u.repo("HrPayslip").create({ id: randomUUID(), runId, employeeId: e.get("id"), number: `DRAFT-${randomUUID().slice(0, 8)}`, period, currency: b.currency, daysInPeriod: b.daysInPeriod, daysPayable: b.daysPayable, unpaidDays: b.unpaidDays, absentDays: b.absentDays, basic: b.basic, housing: b.housing, transport: b.transport, otherAllowance: b.otherAllowance, earnings: b.earnings, deductions: b.deductions, ...t }, { transaction: u.tx });
    }
    await sumRun(u, runId);
    await u.audit({ action: "hr.payroll_run_created", entityType: "hr_payroll_run", entityId: runId, after: { period, skipped: skipped.length } });
    return { ...plain(await u.repo("HrPayrollRun").findById(runId, { transaction: u.tx })), skipped };
  });
}

async function loadRun(u: Uow, id: string) { const r: any = await u.repo("HrPayrollRun").findById(id, { transaction: u.tx }); if (!r) throw new NotFoundError("Payroll run"); return r; }
const num = (v: unknown) => Number(v);

export async function listPayrollRuns(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "hr.salary");
  return withUow(sq, ctx, async (u) => (await u.repo("HrPayrollRun").findAll({ order: [["period", "DESC"]], limit: 36, transaction: u.tx })).map((r: any) => ({ ...plain(r), totalGross: num(r.get("totalGross")), totalDeductions: num(r.get("totalDeductions")), totalNet: num(r.get("totalNet")) })));
}

export async function getPayrollRun(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.salary");
  return withUow(sq, ctx, async (u) => {
    const run = await loadRun(u, id);
    const slips = (await u.repo("HrPayslip").findAll({ where: { runId: id }, transaction: u.tx })) as any[];
    const emps = new Map(((await u.repo("HrEmployee").findAll({ where: { id: { [Op.in]: slips.map((s) => s.get("employeeId")).concat(["-"]) } }, attributes: ["id", "fullName", "employeeNo"], transaction: u.tx })) as any[]).map((e) => [e.get("id"), e]));
    return { run: { ...plain(run), totalGross: num(run.get("totalGross")), totalDeductions: num(run.get("totalDeductions")), totalNet: num(run.get("totalNet")) }, payslips: slips.map((s) => ({ ...slipView(s), employeeName: emps.get(s.get("employeeId"))?.get("fullName") ?? "", employeeNo: emps.get(s.get("employeeId"))?.get("employeeNo") ?? "" })).sort((a, b) => a.employeeName.localeCompare(b.employeeName)) };
  });
}

function slipView(s: any) {
  const p = plain(s);
  return { ...p, daysPayable: num(p.daysPayable), unpaidDays: num(p.unpaidDays), absentDays: num(p.absentDays), basic: num(p.basic), housing: num(p.housing), transport: num(p.transport), otherAllowance: num(p.otherAllowance), gross: num(p.gross), deductionsTotal: num(p.deductionsTotal), net: num(p.net), earnings: (p.earnings ?? []) as Line[], deductions: (p.deductions ?? []) as Line[] };
}

/** Add or remove a one-off earning or deduction on a draft payslip (bonus, advance recovery, fine). A reason is required and audited. */
export async function adjustPayslip(sq: Sequelize, ctx: RequestContext, payslipId: string, o: { type: "earning" | "deduction"; name: string; amount: number; reason: string } | { remove: number; type: "earning" | "deduction" }) {
  authorize(ctx, "hr.salary");
  return withUow(sq, ctx, async (u) => {
    const s: any = await u.repo("HrPayslip").findById(payslipId, { transaction: u.tx });
    if (!s) throw new NotFoundError("Payslip");
    const run = await loadRun(u, s.get("runId"));
    if (run.get("status") !== "draft") throw new ConflictError("Only a draft payroll can be adjusted");
    const earnings: Line[] = [...(s.get("earnings") ?? [])], deductions: Line[] = [...(s.get("deductions") ?? [])];
    const list = o.type === "earning" ? earnings : deductions;
    if ("remove" in o) {
      if (!list[o.remove]?.manual) throw new ConflictError("Only lines added by hand can be removed");
      list.splice(o.remove, 1);
    } else {
      if (!o.name.trim() || !o.reason.trim()) throw new ConflictError("Give the line a name and a reason");
      if (!(o.amount > 0) || o.amount > 10_000_000) throw new ConflictError("Enter an amount above zero");
      list.push({ name: o.name.trim().slice(0, 80), amount: r2(o.amount), manual: true, reason: o.reason.trim().slice(0, 200) });
    }
    const t = totals({ basic: num(s.get("basic")), housing: num(s.get("housing")), transport: num(s.get("transport")), otherAllowance: num(s.get("otherAllowance")) }, earnings, deductions);
    await u.repo("HrPayslip").updateById(payslipId, { earnings, deductions, ...t }, { transaction: u.tx });
    await sumRun(u, run.get("id"));
    await u.audit({ action: "hr.payslip_adjusted", entityType: "hr_payslip", entityId: payslipId, after: "remove" in o ? { removed: o.remove } : { type: o.type, amount: o.amount }, reason: "remove" in o ? "removed a manual line" : o.reason });
    return slipView(await u.repo("HrPayslip").findById(payslipId, { transaction: u.tx }));
  });
}

/** Rebuild a draft from current salaries, leave and attendance (for example after a late correction). Lines added by hand are kept. */
export async function recalculatePayrollRun(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.salary");
  return withUow(sq, ctx, async (u) => {
    const run = await loadRun(u, id);
    if (run.get("status") !== "draft") throw new ConflictError("Only a draft payroll can be recalculated");
    for (const s of (await u.repo("HrPayslip").findAll({ where: { runId: id }, transaction: u.tx })) as any[]) {
      const e: any = await u.repo("HrEmployee").findById(s.get("employeeId"), { transaction: u.tx });
      const b: any = await build(u, ctx, e, run.get("period"));
      if (!b) continue;
      const manualE = ((s.get("earnings") ?? []) as Line[]).filter((x) => x.manual), manualD = ((s.get("deductions") ?? []) as Line[]).filter((x) => x.manual);
      const earnings = [...b.earnings, ...manualE], deductions = [...b.deductions, ...manualD];
      await u.repo("HrPayslip").updateById(s.get("id"), { currency: b.currency, daysInPeriod: b.daysInPeriod, daysPayable: b.daysPayable, unpaidDays: b.unpaidDays, absentDays: b.absentDays, basic: b.basic, housing: b.housing, transport: b.transport, otherAllowance: b.otherAllowance, earnings, deductions, ...totals(b, earnings, deductions) }, { transaction: u.tx });
    }
    await sumRun(u, id);
    await u.audit({ action: "hr.payroll_recalculated", entityType: "hr_payroll_run", entityId: id });
    return { ok: true };
  });
}

export async function deletePayrollRun(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.salary");
  return withUow(sq, ctx, async (u) => {
    const run = await loadRun(u, id);
    if (run.get("status") !== "draft") throw new ConflictError("Only a draft payroll can be deleted");
    await u.sq.query("DELETE FROM hr_payslips WHERE tenant_id=:t AND run_id=:r", { replacements: { t: ctx.tenantId, r: id }, transaction: u.tx });
    await u.repo("HrPayrollRun").deleteById(id, { transaction: u.tx });
    await u.audit({ action: "hr.payroll_deleted", entityType: "hr_payroll_run", entityId: id, after: { period: run.get("period") } });
    return { id };
  });
}

/** Numbers every payslip (PSL-202610-0001) and freezes the run. The person who built the run cannot be the only one to approve it when someone else holds hr.salary. */
export async function approvePayrollRun(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.salary");
  return withUow(sq, ctx, async (u) => {
    const run = await loadRun(u, id);
    if (run.get("status") !== "draft") throw new ConflictError(`This payroll is already ${run.get("status")}`);
    const slips = (await u.repo("HrPayslip").findAll({ where: { runId: id }, order: [["createdAt", "ASC"]], transaction: u.tx })) as any[];
    if (!slips.length) throw new ConflictError("There are no payslips in this payroll");
    for (const s of slips) await u.repo("HrPayslip").updateById(s.get("id"), { number: `PSL-${String(run.get("period")).replace("-", "")}-${String(await nextCounter(u, ctx.tenantId, `payslip_${run.get("period")}`)).padStart(4, "0")}` }, { transaction: u.tx });
    for (const s of slips) await u.sq.query("UPDATE hr_encashments SET status='paid', payroll_run_id=:r WHERE tenant_id=:t AND employee_id=:e AND status='pending'", { replacements: { r: id, t: ctx.tenantId, e: s.get("employeeId") }, transaction: u.tx });
    await u.repo("HrPayrollRun").updateById(id, { status: "approved", approvedBy: ctx.userId, approvedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "hr.payroll_approved", entityType: "hr_payroll_run", entityId: id, after: { period: run.get("period"), employees: slips.length, totalNet: num(run.get("totalNet")) } });
    return plain(await u.repo("HrPayrollRun").findById(id, { transaction: u.tx }));
  });
}

/** Records that the salaries were paid and lets each employee open their payslip. */
export async function markPayrollPaid(sq: Sequelize, ctx: RequestContext, id: string, o: { payDate: string; reference?: string }) {
  authorize(ctx, "hr.salary");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.payDate)) throw new ConflictError("Enter the pay date");
  return withUow(sq, ctx, async (u) => {
    const run = await loadRun(u, id);
    if (run.get("status") !== "approved") throw new ConflictError(run.get("status") === "paid" ? "Already marked as paid" : "Approve the payroll first");
    await u.repo("HrPayrollRun").updateById(id, { status: "paid", payDate: o.payDate, paymentReference: o.reference?.trim().slice(0, 120) || null, paidAt: new Date() }, { transaction: u.tx });
    for (const s of (await u.repo("HrPayslip").findAll({ where: { runId: id }, transaction: u.tx })) as any[]) {
      const e: any = await u.repo("HrEmployee").findById(s.get("employeeId"), { transaction: u.tx });
      if (e?.get("userId")) await notifyUser(u, { userId: e.get("userId"), kind: "hr.payslip", title: `Your payslip for ${run.get("period")} is ready`, entityType: "hr_payslip", entityId: s.get("id"), dedupeKey: `payslip:${s.get("id")}`, path: "/hr/payslips" });
    }
    await u.audit({ action: "hr.payroll_paid", entityType: "hr_payroll_run", entityId: id, after: { payDate: o.payDate, reference: o.reference ?? null } });
    return plain(await u.repo("HrPayrollRun").findById(id, { transaction: u.tx }));
  });
}

/** CSV for the bank upload: employee, IBAN, net pay. Contains bank account numbers, so it needs hr.salary and is audited. */
export async function payrollBankCsv(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.salary");
  return withUow(sq, ctx, async (u) => {
    const run = await loadRun(u, id);
    if (run.get("status") === "draft") throw new ConflictError("Approve the payroll before exporting it");
    const rows: string[][] = [["Employee no", "Employee name", "IBAN", "Net pay", "Currency", "Payslip", "Pay date"]];
    for (const s of (await u.repo("HrPayslip").findAll({ where: { runId: id }, transaction: u.tx })) as any[]) {
      const e: any = await u.repo("HrEmployee").findById(s.get("employeeId"), { transaction: u.tx });
      const sal: any = await u.repo("HrSalary").findOne({ where: { employeeId: s.get("employeeId"), ibanEnc: { [Op.ne]: null } }, order: [["effectiveFrom", "DESC"]], transaction: u.tx });
      rows.push([e.get("employeeNo"), e.get("fullName"), sal?.get("ibanEnc") ? decryptField(sal.get("ibanEnc")) : "", num(s.get("net")).toFixed(2), s.get("currency"), s.get("number"), run.get("payDate") ? String(run.get("payDate")).slice(0, 10) : ""]);
    }
    await u.audit({ action: "hr.payroll_exported", entityType: "hr_payroll_run", entityId: id, after: { rows: rows.length - 1 } });
    // quote every cell and neutralise spreadsheet formulas
    const cell = (v: string) => `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
    return { filename: `payroll-${run.get("period")}.csv`, csv: rows.map((r) => r.map(cell).join(",")).join("\r\n") };
  });
}

/** The caller's own payslips from paid payrolls. */
export async function myPayslips(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    const me = await selfEmployee(u, ctx);
    if (!me) return [];
    const slips = (await u.repo("HrPayslip").findAll({ where: { employeeId: me.get("id") }, order: [["period", "DESC"]], limit: 36, transaction: u.tx })) as any[];
    const runs = new Map(((await u.repo("HrPayrollRun").findAll({ where: { id: { [Op.in]: slips.map((s) => s.get("runId")).concat(["-"]) }, status: "paid" }, transaction: u.tx })) as any[]).map((r) => [r.get("id"), r]));
    return slips.filter((s) => runs.has(s.get("runId"))).map((s) => ({ ...slipView(s), payDate: runs.get(s.get("runId"))!.get("payDate") ? String(runs.get(s.get("runId"))!.get("payDate")).slice(0, 10) : null }));
  });
}

export async function payslipPdf(sq: Sequelize, ctx: RequestContext, payslipId: string) {
  const d = await withUow(sq, ctx, async (u) => {
    const s: any = await u.repo("HrPayslip").findById(payslipId, { transaction: u.tx });
    if (!s) throw new NotFoundError("Payslip");
    const e: any = await u.repo("HrEmployee").findById(s.get("employeeId"), { transaction: u.tx });
    const run = await loadRun(u, s.get("runId"));
    const mine = e.get("userId") === ctx.userId;
    if (!mine && !hasPermission(ctx, "hr.salary")) throw new NotFoundError("Payslip");
    if (mine && !hasPermission(ctx, "hr.salary") && run.get("status") !== "paid") throw new NotFoundError("Payslip");
    const company = ((await u.sq.query("SELECT name FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT })) as unknown as { name: string }[])[0]?.name ?? "";
    return { s: slipView(s), e: plain(e), run: plain(run), company };
  });
  const m = (n: number) => `${d.s.currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const bytes = await renderPdf({
    title: `Payslip ${d.s.period}`, subtitle: d.company, watermark: d.run.status === "paid" ? undefined : "DRAFT",
    meta: [["Employee", `${d.e.fullName} (${d.e.employeeNo})`], ["Designation", d.e.designation ?? "-"], ["Department", d.e.department ?? "-"], ["Payslip no.", d.s.number], ["Period", d.s.period], ["Days paid", `${d.s.daysPayable} of ${d.s.daysInPeriod}`], ["Pay date", d.run.payDate ? String(d.run.payDate).slice(0, 10) : "-"]],
    sections: [
      { heading: "Earnings", table: { columns: ["Item", "Amount"], align: ["left", "right"], rows: [["Basic salary", m(d.s.basic)], ["Housing allowance", m(d.s.housing)], ["Transport allowance", m(d.s.transport)], ["Other allowances", m(d.s.otherAllowance)], ...d.s.earnings.map((x: Line) => [x.name, m(x.amount)]), ["Gross", m(d.s.gross)]] } },
      { heading: "Deductions", table: { columns: ["Item", "Amount"], align: ["left", "right"], rows: d.s.deductions.length ? [...d.s.deductions.map((x: Line) => [x.name, m(x.amount)]), ["Total deductions", m(d.s.deductionsTotal)]] : [["None", m(0)]] } },
      { heading: "Net pay", paragraphs: [m(d.s.net)] },
    ],
    footer: "This payslip was generated by the CRM and is valid without a signature.",
  });
  return { bytes, filename: `payslip-${d.e.employeeNo}-${d.s.period}.pdf` };
}
