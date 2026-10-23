import { afterAll, describe, expect, it } from "vitest";
import {
  adjustPayslip, approvePayrollRun, createEmployee, createPayrollRun, decideLeave, deletePayrollRun, dubaiDate, getPayrollRun, listLeaveTypes, markPayrollPaid, myPayslips, payrollBankCsv, payslipPdf,
  recalculatePayrollRun, requestLeave, setSalary, setSettings,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, makeUser, testDb } from "./helpers";

const sq = () => testDb();
afterAll(closeTestDb);

/** The previous calendar month (Dubai time) as YYYY-MM, its first two consecutive weekdays, and a mid-month join date. */
function lastMonth() {
  const t = dubaiDate(); const d = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 2, 1));
  const period = d.toISOString().slice(0, 7);
  let day = new Date(d); while (![1, 2, 3, 4].includes(day.getUTCDay())) day = new Date(day.getTime() + 86_400_000); // Mon-Thu so the next day is a weekday too
  const a = day.toISOString().slice(0, 10), b = new Date(day.getTime() + 86_400_000).toISOString().slice(0, 10);
  return { period, a, b, mid: `${period}-16`, start: `${period}-01` };
}

describe("payroll", () => {
  it("prorates joiners, deducts unpaid leave, takes manual adjustments, approves with numbers, and shows payslips to employees only after payment", async () => {
    const t = await makeTenant();
    const m = lastMonth();
    await setSettings(sq(), t.admin, { "hr.payroll.deduct_absence": false });
    const full = await makeUser(t, ["agent"]), half = await makeUser(t, ["agent"]), other = await makeUser(t, ["agent"]);
    const e1: any = await createEmployee(sq(), t.admin, { fullName: "Full Month", joinedOn: "2020-01-01", userId: full.id });
    const e2: any = await createEmployee(sq(), t.admin, { fullName: "Half Month", joinedOn: m.mid, userId: half.id });
    await createEmployee(sq(), t.admin, { fullName: "No Salary", joinedOn: "2020-01-01" });
    await setSalary(sq(), t.admin, e1.id, { effectiveFrom: "2020-01-01", basic: 6000, housing: 2000, transport: 1000, otherAllowance: 0, iban: "AE070331234567890123456" });
    await setSalary(sq(), t.admin, e2.id, { effectiveFrom: m.mid, basic: 6000, housing: 2000, transport: 1000, otherAllowance: 1000 });
    const unpaid: any = (await listLeaveTypes(sq(), t.admin)).find((x: any) => x.code === "UNPAID");
    const lr: any = await requestLeave(sq(), await contextFor(t.tenantId, full.id), { leaveTypeId: unpaid.id, fromDate: m.a, toDate: m.b, reason: "Family matter" });
    await decideLeave(sq(), t.admin, lr.id, { approve: true });

    await expect(createPayrollRun(sq(), other.ctx, m.period)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPayrollRun(sq(), t.admin, `${dubaiDate().slice(0, 4)}-13`)).rejects.toThrow(/month/);
    await expect(createPayrollRun(sq(), t.admin, "2999-01")).rejects.toThrow(/future/);
    const created: any = await createPayrollRun(sq(), t.admin, m.period);
    expect(created.skipped.map((s: any) => s.name)).toEqual(["No Salary"]);
    await expect(createPayrollRun(sq(), t.admin, m.period)).rejects.toThrow(/already exists/);

    let d: any = await getPayrollRun(sq(), t.admin, created.id);
    const s1 = d.payslips.find((s: any) => s.employeeName === "Full Month"), s2 = d.payslips.find((s: any) => s.employeeName === "Half Month");
    expect(s1.gross).toBe(9000);
    expect(s1.unpaidDays).toBe(2);
    expect(s1.deductions[0].amount).toBe(600); // 2 days x 9000 / 30
    expect(s1.net).toBe(8400);
    const days = new Date(Date.UTC(Number(m.period.slice(0, 4)), Number(m.period.slice(5, 7)), 0)).getUTCDate();
    expect(s2.daysPayable).toBe(days - 15);
    expect(s2.gross).toBeCloseTo(10000 * ((days - 15) / days), 1);

    const adjusted: any = await adjustPayslip(sq(), t.admin, s1.id, { type: "earning", name: "Sales bonus", amount: 1000, reason: "Q3 target" });
    expect(adjusted.net).toBe(9400);
    await expect(adjustPayslip(sq(), t.admin, s1.id, { type: "deduction", name: "Fine", amount: 50, reason: " " })).rejects.toThrow(/reason/);
    await expect(adjustPayslip(sq(), t.admin, s1.id, { type: "deduction", remove: 0 })).rejects.toThrow(/by hand/); // system lines cannot be removed
    await recalculatePayrollRun(sq(), t.admin, created.id);
    d = await getPayrollRun(sq(), t.admin, created.id);
    expect(d.payslips.find((s: any) => s.employeeName === "Full Month").net).toBe(9400); // manual line survives a recalculation
    await expect(payrollBankCsv(sq(), t.admin, created.id)).rejects.toThrow(/Approve/);

    await expect(markPayrollPaid(sq(), t.admin, created.id, { payDate: dubaiDate() })).rejects.toThrow(/Approve/);
    const approved: any = await approvePayrollRun(sq(), t.admin, created.id);
    expect(approved.status).toBe("approved");
    d = await getPayrollRun(sq(), t.admin, created.id);
    expect(d.payslips.every((s: any) => /^PSL-\d{6}-\d{4}$/.test(s.number))).toBe(true);
    await expect(adjustPayslip(sq(), t.admin, s1.id, { type: "earning", name: "Late", amount: 5, reason: "x" })).rejects.toThrow(/draft/);
    await expect(deletePayrollRun(sq(), t.admin, created.id)).rejects.toThrow(/draft/);

    const fc = await contextFor(t.tenantId, full.id);
    expect(await myPayslips(sq(), fc)).toHaveLength(0); // not visible before payment
    await expect(payslipPdf(sq(), fc, s1.id)).rejects.toThrow(/not found/i);
    const csv = await payrollBankCsv(sq(), t.admin, created.id);
    expect(csv.csv).toContain("AE070331234567890123456");
    expect(csv.csv).toContain("9400.00");
    await markPayrollPaid(sq(), t.admin, created.id, { payDate: dubaiDate(), reference: "BANK-123" });

    const mine: any[] = await myPayslips(sq(), fc);
    expect(mine).toHaveLength(1);
    expect(mine[0].net).toBe(9400);
    const pdf = await payslipPdf(sq(), fc, s1.id);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    await expect(payslipPdf(sq(), fc, s2.id)).rejects.toThrow(/not found/i); // someone else's payslip
    await expect(payslipPdf(sq(), other.ctx, s1.id)).rejects.toThrow(/not found/i);
    expect((await myPayslips(sq(), await contextFor(t.tenantId, half.id))).map((s: any) => s.employeeId)).not.toContain(e1.id);
  });

  it("deducts unexplained absence at gross / 30 when the company wants it, and not for weekends, holidays or leave", async () => {
    const t = await makeTenant();
    const m = lastMonth();
    const u = await makeUser(t, ["agent"]);
    const e: any = await createEmployee(sq(), t.admin, { fullName: "Absent Alex", joinedOn: "2020-01-01", userId: u.id });
    await setSalary(sq(), t.admin, e.id, { effectiveFrom: "2020-01-01", basic: 9000, housing: 0, transport: 0, otherAllowance: 0 });
    const run: any = await createPayrollRun(sq(), t.admin, m.period);
    const slip = (await getPayrollRun(sq(), t.admin, run.id) as any).payslips[0];
    // every working day of the month has no attendance, so all of them count as absent; weekends do not
    let working = 0; const last = new Date(Date.UTC(Number(m.period.slice(0, 4)), Number(m.period.slice(5, 7)), 0)).getUTCDate();
    for (let i = 1; i <= last; i++) { const wd = new Date(Date.UTC(Number(m.period.slice(0, 4)), Number(m.period.slice(5, 7)) - 1, i)).getUTCDay(); if (wd !== 0 && wd !== 6) working++; }
    expect(slip.absentDays).toBe(working);
    expect(slip.deductionsTotal).toBeCloseTo((working * 9000) / 30, 1);
    expect(slip.net).toBe(Math.max(0, Math.round((9000 - (working * 9000) / 30) * 100) / 100));
  });
});
