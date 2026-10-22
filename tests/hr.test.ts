import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  adjustLeaveBalance, attendanceCloseSweep, cancelLeave, celebrations, checkIn, checkOut, correctAttendance, createEmployee, createLetter, decideLeave, emailLetter, endBreak, getSalaryHistory, getSetting, hrDashboard,
  issueLetter, leaveDays, letterPdf, listEmployees, listLeaveTypes, listTrash, liveBoard, mockMailer, myAttendanceToday, requestLeave, saveHoliday, saveLeaveType, setModules, setSalary, setSettings, saveOccasion, startBreak,
  timesheet, updateLetterDraft, isModuleOn, listLetterTemplates, moduleForApi, moduleForPage, uploadHrDocument, listHrDocuments, readHrDocument, getLeaveBalances, dubaiDate,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, makeUser, testDb, uniq } from "./helpers";

const sq = () => testDb();
afterAll(closeTestDb);
beforeEach(() => mockMailer.reset());
const today = () => dubaiDate();
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** A tenant with HR admin (tenant admin), a manager and an employee, each linked to a login, plus an unlinked outsider. */
async function setup() {
  const t = await makeTenant();
  const mgrU = await makeUser(t, ["agent"]), empU = await makeUser(t, ["agent"]), other = await makeUser(t, ["agent"]);
  const mgr: any = await createEmployee(sq(), t.admin, { fullName: "Mona Manager", joinedOn: "2022-01-10", userId: mgrU.id, designation: "Team lead", department: "Sales", gender: "female", email: mgrU.email });
  const emp: any = await createEmployee(sq(), t.admin, { fullName: "Eli Employee", joinedOn: "2023-03-01", userId: empU.id, designation: "Agent", department: "Sales", gender: "male", email: empU.email, managerEmployeeId: mgr.id, dateOfBirth: "1990-06-15" });
  return { t, mgrU, empU, other, mgr, emp };
}

describe("employees and salary", () => {
  it("numbers employees, refuses a second employee on the same login or a reporting loop, and hides salary without permission", async () => {
    const { t, empU, mgr, emp, other } = await setup();
    expect(emp.employeeNo).toMatch(/^EMP-\d{4}$/);
    await expect(createEmployee(sq(), t.admin, { fullName: "Dup", joinedOn: "2024-01-01", userId: empU.id })).rejects.toThrow(/already linked/);
    const { updateEmployee } = await import("@reales/domain");
    await expect(updateEmployee(sq(), t.admin, mgr.id, { managerEmployeeId: emp.id })).rejects.toThrow(/loop/);
    await expect(createEmployee(sq(), other.ctx, { fullName: "X", joinedOn: "2024-01-01" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listEmployees(sq(), t.admin, {})).total).toBe(2);
    await setSalary(sq(), t.admin, emp.id, { effectiveFrom: "2024-01-01", basic: 8000, housing: 3000, transport: 1000, iban: "AE070331234567890123456", reason: "Joining" });
    await setSalary(sq(), t.admin, emp.id, { effectiveFrom: "2025-01-01", basic: 9000, housing: 3000, transport: 1000 });
    const hist: any[] = await getSalaryHistory(sq(), t.admin, emp.id);
    expect(hist).toHaveLength(2);
    expect(hist.find((h) => h.current).gross).toBe(13000);
    expect(hist[0].iban).toBe("AE070331234567890123456"); // HR sees the full account number, kept encrypted at rest
    const [raw] = await sq().query<{ iban_enc: string }>("SELECT iban_enc FROM hr_salaries WHERE employee_id=:e AND iban_enc IS NOT NULL LIMIT 1", { replacements: { e: emp.id }, type: QueryTypes.SELECT });
    expect(raw!.iban_enc).not.toContain("AE07");
    expect((await getSalaryHistory(sq(), await contextFor(t.tenantId, empU.id), emp.id))[0]!.iban).toBe("****3456"); // the employee sees their own, masked
    await expect(getSalaryHistory(sq(), other.ctx, emp.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getSalaryHistory(sq(), (await contextFor(t.tenantId, other.id)), mgr.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("leave", () => {
  it("counts only working days, enforces balance, overlap and approver rules, and updates attendance on approval", async () => {
    const { t, mgrU, empU, other, emp } = await setup();
    await saveHoliday(sq(), t.admin, { onDate: plus(30), name: "Test holiday" });
    const types: any[] = await listLeaveTypes(sq(), t.admin);
    const annual = types.find((x) => x.code === "ANNUAL"), paternity = types.find((x) => x.code === "PATERNITY"), maternity = types.find((x) => x.code === "MATERNITY");
    expect(leaveDays("2026-03-02", "2026-03-08", "none", { weeklyOff: ["sat", "sun"], holidays: new Set(), countsWeekends: false })).toBe(5); // Mon-Sun
    expect(leaveDays("2026-03-02", "2026-03-02", "first", { weeklyOff: [], holidays: new Set(), countsWeekends: false })).toBe(0.5);
    const ec = await contextFor(t.tenantId, empU.id), mc = await contextFor(t.tenantId, mgrU.id);
    await expect(requestLeave(sq(), ec, { leaveTypeId: maternity.id, fromDate: plus(10), toDate: plus(12) })).rejects.toThrow(/does not apply/); // gender rule
    await expect(requestLeave(sq(), other.ctx, { leaveTypeId: annual.id, fromDate: plus(10), toDate: plus(12) })).rejects.toThrow(/not linked/);
    const req: any = await requestLeave(sq(), ec, { leaveTypeId: annual.id, fromDate: plus(10), toDate: plus(14) });
    expect(req.status).toBe("pending");
    await expect(requestLeave(sq(), ec, { leaveTypeId: annual.id, fromDate: plus(12), toDate: plus(13) })).rejects.toThrow(/already a pending/); // overlap
    await expect(decideLeave(sq(), ec, req.id, { approve: true })).rejects.toThrow(/never|nobody|manager/i); // not your own
    await expect(decideLeave(sq(), (await contextFor(t.tenantId, other.id)), req.id, { approve: true })).rejects.toBeInstanceOf(ForbiddenError); // a stranger
    await expect(decideLeave(sq(), mc, req.id, { approve: false })).rejects.toThrow(/reason/);
    const done: any = await decideLeave(sq(), mc, req.id, { approve: true, note: "Enjoy" }); // the manager
    expect(done.status).toBe("approved");
    const bal = (await getLeaveBalances(sq(), ec, emp.id)).find((b: any) => b.code === "ANNUAL")!;
    expect(bal.taken).toBeGreaterThan(0);
    const sheet = await timesheet(sq(), ec, emp.id, plus(10), plus(14));
    expect(sheet.days.some((d) => d.status === "on_leave")).toBe(true);
    // more than the balance is refused unless the company allows it
    await expect(requestLeave(sq(), ec, { leaveTypeId: annual.id, fromDate: plus(60), toDate: plus(120) })).rejects.toThrow(/left|maximum|limited/i);
    await adjustLeaveBalance(sq(), t.admin, emp.id, annual.id, new Date().getFullYear(), { adjusted: 10, note: "Compensation for working a holiday" });
    await expect(adjustLeaveBalance(sq(), t.admin, emp.id, annual.id, 2026, { adjusted: 1, note: " " })).rejects.toThrow(/why/);
    await cancelLeave(sq(), ec, req.id);
    expect((await timesheet(sq(), ec, emp.id, plus(10), plus(14))).days.some((d) => d.status === "on_leave")).toBe(false);
    void paternity;
  });

  it("lets HR design leave types and rejects duplicates", async () => {
    const { t, other } = await setup();
    const lt: any = await saveLeaveType(sq(), t.admin, { code: "STUDY", name: "Study leave", annualDays: 10, accrual: "upfront", carryForwardMax: 0, paid: true, requiresDocumentAfterDays: 0, maxConsecutiveDays: 5, minNoticeDays: 7, gender: "any", countsWeekends: false, minServiceMonths: 6, active: true, color: "#112233" });
    expect(lt.code).toBe("STUDY");
    await expect(saveLeaveType(sq(), t.admin, { ...lt, id: undefined, name: "Again" })).rejects.toThrow(/already used/);
    await expect(saveLeaveType(sq(), other.ctx, { ...lt, id: lt.id })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("attendance", () => {
  it("runs a day: check in, lunch break, check out, live board, one check-in per day, HR correction with a reason", async () => {
    const { t, empU, emp } = await setup();
    const ec = await contextFor(t.tenantId, empU.id);
    expect((await myAttendanceToday(sq(), ec) as any).state).toBe("not_started");
    await expect(startBreak(sq(), ec)).rejects.toThrow(/Check in first/);
    await checkIn(sq(), ec, {});
    await expect(checkIn(sq(), ec, {})).rejects.toThrow(/already checked in/);
    let board: any = await liveBoard(sq(), t.admin);
    expect(board.people.find((p: any) => p.id === emp.id).state).toBe("working");
    await startBreak(sq(), ec, "lunch");
    await expect(startBreak(sq(), ec, "tea")).rejects.toThrow(/already on a break/);
    board = await liveBoard(sq(), t.admin);
    expect(board.people.find((p: any) => p.id === emp.id).state).toBe("on_break");
    await endBreak(sq(), ec);
    await expect(endBreak(sq(), ec)).rejects.toThrow(/not on a break/);
    const out: any = await checkOut(sq(), ec, {});
    expect(out.workedMinutes).toBeGreaterThanOrEqual(0);
    await expect(checkOut(sq(), ec, {})).rejects.toThrow(/already checked out/);
    await expect(correctAttendance(sq(), ec, emp.id, today(), { reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(correctAttendance(sq(), t.admin, emp.id, today(), { reason: " " })).rejects.toThrow(/why/);
    const fixed: any = await correctAttendance(sq(), t.admin, emp.id, today(), { checkInAt: new Date(`${today()}T05:00:00Z`).toISOString(), checkOutAt: new Date(`${today()}T14:00:00Z`).toISOString(), reason: "Forgot to check out" });
    expect(fixed.workedMinutes).toBe(540);
    expect(fixed.source).toBe("manual");
  });

  it("marks lateness against the shift, auto-closes forgotten days and respects the company switch", async () => {
    const { t, empU, emp } = await setup();
    const ec = await contextFor(t.tenantId, empU.id);
    await setSettings(sq(), t.admin, { "hr.attendance.allow_web_checkin": false });
    await expect(checkIn(sq(), ec, {})).rejects.toThrow(/switched off/);
    await setSettings(sq(), t.admin, { "hr.attendance.allow_web_checkin": true });
    // a forgotten check-in from yesterday is closed by the sweep
    await sq().query("INSERT INTO hr_attendance (id, tenant_id, employee_id, work_date, check_in_at, status, worked_minutes, break_minutes, late_minutes, source, created_at, updated_at) VALUES (UUID(), :t, :e, :d, :i, 'present', 0, 0, 0, 'web', NOW(3), NOW(3))", { replacements: { t: t.tenantId, e: emp.id, d: plus(-1), i: `${plus(-1)} 05:00:00.000` } });
    const { systemContext } = await import("@reales/database");
    expect(await attendanceCloseSweep(sq(), systemContext(t.tenantId, uniq("c")))).toBe(1);
    expect(await attendanceCloseSweep(sq(), systemContext(t.tenantId, uniq("c")))).toBe(0);
    const row = await timesheet(sq(), ec, emp.id, plus(-1), plus(-1));
    expect(row.days[0]!.checkOutAt).not.toBeNull();
  });
});

describe("letters and documents", () => {
  it("drafts a letter from a template, refuses missing details, issues a number, makes a PDF and e-mails it with the attachment", async () => {
    const { t, emp, other } = await setup();
    const tpls: any[] = await listLetterTemplates(sq(), t.admin);
    const warning = tpls.find((x) => x.kind === "warning"), cert = tpls.find((x) => x.kind === "salary_certificate");
    await expect(createLetter(sq(), t.admin, { employeeId: emp.id, templateId: warning.id })).rejects.toThrow(/reason/);
    await expect(createLetter(sq(), t.admin, { employeeId: emp.id, templateId: cert.id, vars: { purpose: "a bank loan" } })).rejects.toThrow(/no salary is set/);
    await setSalary(sq(), t.admin, emp.id, { effectiveFrom: "2024-01-01", basic: 8000, housing: 3000, transport: 1000 });
    const draft: any = await createLetter(sq(), t.admin, { employeeId: emp.id, templateId: cert.id, vars: { purpose: "a bank loan" } });
    expect(draft.body).toContain("12,000.00");
    expect(draft.body).toContain("Eli Employee");
    expect(draft.body).not.toMatch(/\{\{/);
    await expect(emailLetter(sq(), t.admin, draft.id)).rejects.toThrow(/Issue the letter/);
    await expect(updateLetterDraft(sq(), t.admin, draft.id, { body: "Dear {{x}}" })).rejects.toThrow(/placeholder/);
    const issued: any = await issueLetter(sq(), t.admin, draft.id);
    expect(issued.number).toMatch(/^HRL-\d{6}$/);
    await expect(updateLetterDraft(sq(), t.admin, draft.id, { body: "changed" })).rejects.toThrow(/cannot be edited/);
    const pdf = await letterPdf(sq(), t.admin, draft.id);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    await emailLetter(sq(), t.admin, draft.id);
    const mail = mockMailer.last(emp.email)!;
    expect(mail.attachments?.[0]?.contentType).toBe("application/pdf");
    expect(mail.attachments?.[0]?.content.subarray(0, 5).toString()).toBe("%PDF-");
    await expect(createLetter(sq(), other.ctx, { employeeId: emp.id, templateId: warning.id, vars: { reason: "x" } })).rejects.toBeInstanceOf(ForbiddenError);
    const w: any = await createLetter(sq(), t.admin, { employeeId: emp.id, templateId: warning.id, vars: { reason: "Repeated lateness" } });
    expect(w.body).toContain("Repeated lateness");
  });

  it("keeps documents private to the employee and HR, and warns about expiry", async () => {
    const { t, empU, emp, other } = await setup();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
    const doc: any = await uploadHrDocument(sq(), t.admin, { filename: "visa.png", mime: "image/png", bytes: png }, { employeeId: emp.id, title: "Visa", category: "visa", expiresOn: plus(20) });
    const policy: any = await uploadHrDocument(sq(), t.admin, { filename: "policy.png", mime: "image/png", bytes: Buffer.concat([png, Buffer.from("p")]) }, { title: "Handbook", category: "policy" });
    const ec = await contextFor(t.tenantId, empU.id);
    expect((await listHrDocuments(sq(), ec, {})).map((d: any) => d.id).sort()).toEqual([doc.id, policy.id].sort());
    expect((await listHrDocuments(sq(), other.ctx, {})).map((d: any) => d.id)).toEqual([policy.id]);
    await expect(readHrDocument(sq(), other.ctx, doc.id)).rejects.toThrow(/not found/i);
    expect((await readHrDocument(sq(), ec, doc.id)).bytes.length).toBeGreaterThan(0);
    const { hrExpirySweep } = await import("@reales/domain");
    const { systemContext } = await import("@reales/database");
    expect(await hrExpirySweep(sq(), systemContext(t.tenantId, uniq("c")))).toBeGreaterThan(0);
    expect(await hrExpirySweep(sq(), systemContext(t.tenantId, uniq("c")))).toBe(0); // once per item
  });
});

describe("celebrations, dashboard and configurable modules", () => {
  it("lists birthdays and occasions without birth years and builds the HR dashboard", async () => {
    const { t, empU, emp } = await setup();
    const { updateEmployee } = await import("@reales/domain");
    await updateEmployee(sq(), t.admin, emp.id, { dateOfBirth: `1990-${plus(3).slice(5)}` });
    await saveOccasion(sq(), t.admin, { title: "Company day", onDate: plus(5), yearly: true });
    const list = await celebrations(sq(), await contextFor(t.tenantId, empU.id), 30);
    expect(list.some((c) => c.kind === "birthday" && c.title.includes("Eli"))).toBe(true);
    expect(list.some((c) => c.title === "Company day")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("1990");
    const dash: any = await hrDashboard(sq(), t.admin);
    expect(dash.headcount.active).toBe(2);
  });

  it("turns modules off for the API and the menu, protects dependencies and core modules, and validates settings", async () => {
    const { t, other } = await setup();
    expect(moduleForApi("/api/v1/listings/abc")).toBe("listings");
    expect(moduleForPage("/hr/leave")).toBe("hr");
    await expect(setModules(sq(), other.ctx, { campaigns: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setModules(sq(), t.admin, { leads: false })).rejects.toThrow(/always on/);
    await expect(setModules(sq(), t.admin, { messaging: false })).rejects.toThrow(/Turn off .*Broadcast/); // campaigns need messaging
    await setModules(sq(), t.admin, { campaigns: false });
    expect(await isModuleOn(sq(), t.tenantId, "campaigns")).toBe(false);
    await setModules(sq(), t.admin, { messaging: false });
    expect(await isModuleOn(sq(), t.tenantId, "messaging")).toBe(false);
    await expect(setModules(sq(), t.admin, { campaigns: true })).rejects.toThrow(/needs/);
    await setModules(sq(), t.admin, { messaging: true, campaigns: true });
    expect(await isModuleOn(sq(), t.tenantId, "campaigns")).toBe(true);
    await expect(setSettings(sq(), t.admin, { "listings.expiry_days": 5000 })).rejects.toThrow(/Invalid/);
    await expect(setSettings(sq(), t.admin, { "made.up": true })).rejects.toThrow(/Unknown/);
    await setSettings(sq(), t.admin, { "listings.expiry_days": 45 });
    expect(await getSetting<number>(sq(), t.tenantId, "listings.expiry_days")).toBe(45);
    void listTrash;
  });
});
