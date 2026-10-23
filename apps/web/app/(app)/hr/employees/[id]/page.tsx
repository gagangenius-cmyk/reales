import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getEmployee, getLeaveBalances, getSalaryHistory, listEncashments, listLeaveTypes, listAssignableUsers, listEmployees, listHrDocuments, listLetters, listShifts } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { EmployeeForm } from "../employee-form";
import { BalanceAdjust, EncashPanel, SalaryPanel } from "./employee-client";

export const metadata = { title: "Employee | Reales CRM" };
const d = (s: unknown) => (s ? String(s).slice(0, 10) : "-");

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;
  const sq = getSequelize();
  let e: any;
  try { e = await getEmployee(sq, ctx, id); } catch { return <section><h1 className="text-2xl font-semibold">Employee not found</h1><Link className="btn-ghost mt-3 inline-block" href="/hr/employees">Back to employees</Link></section>; }
  const manage = hasPermission(ctx, "hr.manage");
  const canPay = hasPermission(ctx, "hr.salary");
  const [encs, encTypes] = await Promise.all([canPay ? listEncashments(sq, ctx, id) : Promise.resolve([]), canPay ? listLeaveTypes(sq, ctx) : Promise.resolve([])]);
  const [salary, balances, docs, letters, shifts, users, all] = await Promise.all([
    e.canSeeSalary ? getSalaryHistory(sq, ctx, id).catch(() => []) : Promise.resolve([]), getLeaveBalances(sq, ctx, id).catch(() => []),
    listHrDocuments(sq, ctx, { employeeId: id }), hasPermission(ctx, "hr.letters") ? listLetters(sq, ctx, { employeeId: id }) : Promise.resolve([]),
    manage ? listShifts(sq, ctx) : Promise.resolve([]), manage ? listAssignableUsers(sq, ctx).catch(() => []) : Promise.resolve([]), manage ? listEmployees(sq, ctx, { limit: 200 }) : Promise.resolve(null),
  ]);
  const row = (k: string, v: string) => <div className="flex justify-between gap-3 border-b py-2 text-sm" style={{ borderColor: "var(--border)" }}><span className="muted">{k}</span><span className="text-right font-medium">{v || "-"}</span></div>;
  const initial = {
    fullName: e.fullName, email: e.email ?? "", phone: e.phone ?? "", designation: e.designation ?? "", department: e.department ?? "", employmentType: e.employmentType, joinedOn: d(e.joinedOn).replace("-", "-"), probationEndsOn: e.probationEndsOn ? d(e.probationEndsOn) : "", dateOfBirth: e.dateOfBirth ? d(e.dateOfBirth) : "",
    gender: e.gender ?? "", nationality: e.nationality ?? "", workLocation: e.workLocation ?? "", shiftId: e.shiftId ?? "", managerEmployeeId: e.managerEmployeeId ?? "", userId: e.userId ?? "", passportExpiresOn: e.passportExpiresOn ? d(e.passportExpiresOn) : "",
    visaExpiresOn: e.visaExpiresOn ? d(e.visaExpiresOn) : "", emiratesIdExpiresOn: e.emiratesIdExpiresOn ? d(e.emiratesIdExpiresOn) : "", labourCardNo: e.labourCardNo ?? "", notes: e.notes ?? "", status: e.status, exitOn: e.exitOn ? d(e.exitOn) : "", exitReason: e.exitReason ?? "",
  };
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head">
        <div><Link className="muted text-sm" href="/hr/employees">&larr; Employees</Link><h1>{e.fullName}</h1><p className="muted text-sm">{e.employeeNo} - {e.designation ?? "No title"}{e.department ? `, ${e.department}` : ""} - <span className={e.status === "exited" ? "err" : ""}>{e.status.replace("_", " ")}</span></p></div>
        <div className="flex flex-wrap gap-2">{manage && <EmployeeForm id={id} initial={initial} shifts={(shifts as any[]).map((s) => ({ id: s.id, name: s.name }))} users={users.map((u: any) => ({ id: u.id, email: u.email }))} managers={(all?.rows ?? []).map((x: any) => ({ id: x.id, name: x.fullName }))} />}{hasPermission(ctx, "hr.letters") && <Link className="btn" href={`/hr/letters?employee=${id}`}>Write a letter</Link>}</div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4"><h2 className="mb-2 font-semibold">Profile</h2>
          {row("E-mail", e.email)}{row("Phone", e.phone)}{row("Joined", d(e.joinedOn))}{row("Probation ends", e.probationEndsOn ? d(e.probationEndsOn) : "")}{row("Type", String(e.employmentType).replace("_", " "))}{row("Reports to", e.manager?.fullName ?? "")}{row("Shift", e.shift ? `${e.shift.name}` : "")}{row("Work location", e.workLocation)}{row("Nationality", e.nationality)}{row("Labour card", e.labourCardNo)}
          {row("Passport expires", e.passportExpiresOn ? d(e.passportExpiresOn) : "")}{row("Visa expires", e.visaExpiresOn ? d(e.visaExpiresOn) : "")}{row("Emirates ID expires", e.emiratesIdExpiresOn ? d(e.emiratesIdExpiresOn) : "")}
          {e.exitOn && row("Last working day", d(e.exitOn))}
        </div>
        <div className="card p-4"><h2 className="mb-2 font-semibold">Leave balances this year</h2>
          <table className="t"><thead><tr><th>Type</th><th>Earned</th><th>Taken</th><th>Left</th></tr></thead>
            <tbody>{(balances as any[]).map((b) => <tr key={b.leaveTypeId}><td>{b.name}</td><td>{b.unlimited ? "-" : b.entitled + b.carried + b.adjusted}</td><td>{b.taken}{b.pending ? ` (+${b.pending} pending)` : ""}</td><td className="font-medium">{b.unlimited ? "Unlimited" : b.available}</td></tr>)}</tbody></table>
          {manage && <BalanceAdjust employeeId={id} types={(balances as any[]).filter((b) => !b.unlimited).map((b) => ({ id: b.leaveTypeId, name: b.name }))} />}
        </div>
      </div>
      {canPay && <EncashPanel employeeId={id} currency={(salary as any[])[0]?.currency ?? "AED"} items={encs as never} types={(encTypes as any[]).filter((t) => t.encashable).map((t) => ({ id: t.id, name: t.name, available: ((balances as any[]).find((b) => b.leaveTypeId === t.id)?.available ?? 0) }))} />}
      {e.canSeeSalary && <SalaryPanel employeeId={id} history={salary as any} canEdit={hasPermission(ctx, "hr.salary")} />}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4"><div className="mb-2 flex items-baseline justify-between"><h2 className="font-semibold">Documents</h2><Link className="text-xs" href={`/hr/documents?employee=${id}`}>Manage</Link></div>
          {docs.length === 0 ? <p className="muted text-sm">No documents.</p> : <ul className="flex flex-col gap-1.5 text-sm">{(docs as any[]).map((x) => <li key={x.id} className="flex justify-between gap-2"><a href={`/api/v1/hr/documents/${x.id}`}>{x.title}</a><span className={x.expiresOn && String(x.expiresOn).slice(0, 10) < new Date().toISOString().slice(0, 10) ? "err text-xs" : "muted text-xs"}>{x.expiresOn ? `expires ${d(x.expiresOn)}` : x.category}</span></li>)}</ul>}</div>
        {hasPermission(ctx, "hr.letters") && <div className="card p-4"><h2 className="mb-2 font-semibold">Letters</h2>
          {letters.length === 0 ? <p className="muted text-sm">No letters yet.</p> : <ul className="flex flex-col gap-1.5 text-sm">{(letters as any[]).map((x) => <li key={x.id} className="flex justify-between gap-2"><a href={`/api/v1/hr/letters/${x.id}/pdf`}>{x.subject}</a><span className="muted text-xs">{x.number.startsWith("DRAFT") ? "draft" : x.number} - {x.status}</span></li>)}</ul>}</div>}
      </div>
    </section>
  );
}
