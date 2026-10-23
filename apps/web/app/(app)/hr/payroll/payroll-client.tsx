"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lbl, useAction } from "@/components/hr-ui";

interface Run { id: string; period: string; status: string; payDate: string | null; employeesCount: number; totalGross: number; totalDeductions: number; totalNet: number; paymentReference: string | null }
interface Line { name: string; amount: number; manual?: boolean; reason?: string }
interface Slip { id: string; number: string; employeeName: string; employeeNo: string; currency: string; daysPayable: number; daysInPeriod: number; unpaidDays: number; absentDays: number; gross: number; deductionsTotal: number; net: number; earnings: Line[]; deductions: Line[] }
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const badge = (s: string) => (s === "paid" ? "badge-ok" : s === "approved" ? "" : "badge-warn");

export function PayrollClient({ runs, detail }: { runs: Run[]; detail: { run: Run; payslips: Slip[] } | null }) {
  const router = useRouter();
  const { busy, run, Msg, post } = useAction();
  const [period, setPeriod] = useState(new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 7));
  const [open, setOpen] = useState<string | null>(null);
  const [adj, setAdj] = useState({ type: "earning", name: "", amount: "", reason: "" });
  const [pay, setPay] = useState({ payDate: new Date().toISOString().slice(0, 10), reference: "" });
  const [code, setCode] = useState<{ then: "approve" | "export"; value: string } | null>(null);
  const r = detail?.run;

  async function stepUpThen(action: "approve" | "export") {
    const res = action === "approve" ? await post(`/api/v1/hr/payroll/${r!.id}/approve`, {}) : null;
    if (action === "export") { window.location.href = `/api/v1/hr/payroll/${r!.id}/export`; return; }
    if (res && !res.ok && res.data?.error?.code === "step_up_required") setCode({ then: action, value: "" });
    else if (res?.ok) router.refresh();
    else if (res) alert(res.data?.error?.message ?? "Failed");
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault(); if (!code) return;
    const res = await post("/api/v1/auth/step-up", { code: code.value.trim() });
    if (!res.ok) return alert(res.data?.error?.message ?? "Code not accepted");
    const then = code.then; setCode(null);
    await stepUpThen(then);
  }
  return (
    <div className="flex flex-col gap-5">
      <Msg />
      <form className="card flex flex-wrap items-end gap-3 p-3" onSubmit={(e) => { e.preventDefault(); void run(() => post("/api/v1/hr/payroll", { period }), "Payroll created.", (d) => router.push(`/hr/payroll?run=${d.id}`)); }}>
        <Lbl label="New payroll for month"><input className="input" type="month" required value={period} onChange={(e) => setPeriod(e.target.value)} /></Lbl>
        <button className="btn" disabled={busy}>Create payroll</button>
        <div className="flex flex-wrap gap-2 text-sm">{runs.map((x) => <button key={x.id} type="button" className={r?.id === x.id ? "btn" : "btn-ghost"} onClick={() => router.push(`/hr/payroll?run=${x.id}`)}>{x.period} <span className="opacity-70">({x.status})</span></button>)}</div>
      </form>
      {code && (
        <form onSubmit={verify} className="card flex flex-wrap items-end gap-3 p-3 text-sm">
          <Lbl label="Authenticator code to confirm"><input className="input w-40" inputMode="numeric" autoComplete="one-time-code" value={code.value} onChange={(e) => setCode({ ...code, value: e.target.value })} /></Lbl>
          <button className="btn" disabled={!code.value.trim()}>Verify and continue</button><button type="button" className="btn-ghost" onClick={() => setCode(null)}>Cancel</button>
        </form>
      )}
      {r && detail && (
        <>
          <div className="grid gap-3 sm:grid-cols-5">
            {([["Month", r.period], ["Employees", String(r.employeesCount)], ["Gross", money(r.totalGross)], ["Deductions", money(r.totalDeductions)], ["Net pay", money(r.totalNet)]] as [string, string][]).map(([l, v]) => <div key={l} className="card stat"><span className="muted text-xs">{l}</span><b>{v}</b></div>)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`badge ${badge(r.status)}`}>{r.status}</span>
            {r.status === "draft" && (
              <>
                <button className="btn-ghost" disabled={busy} onClick={() => run(() => post(`/api/v1/hr/payroll/${r.id}/recalculate`, {}), "Recalculated from the latest salaries, leave and attendance.")}>Recalculate</button>
                <button className="btn" disabled={busy} onClick={() => confirm("Approve this payroll? Payslips are numbered and frozen.") && stepUpThen("approve")}>Approve</button>
                <button className="btn-ghost err" disabled={busy} onClick={() => confirm("Delete this draft payroll?") && run(() => post(`/api/v1/hr/payroll/${r.id}`, undefined, "DELETE"), "Deleted.", () => router.push("/hr/payroll"))}>Delete draft</button>
              </>
            )}
            {r.status !== "draft" && <button className="btn-ghost" onClick={() => stepUpThen("export")}>Download bank file (CSV)</button>}
            {r.status === "approved" && (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => post(`/api/v1/hr/payroll/${r.id}/paid`, { payDate: pay.payDate, ...(pay.reference.trim() ? { reference: pay.reference.trim() } : {}) }), "Marked as paid. Employees can now open their payslips."); }}>
                <Lbl label="Pay date"><input className="input" type="date" required value={pay.payDate} onChange={(e) => setPay({ ...pay, payDate: e.target.value })} /></Lbl>
                <Lbl label="Bank reference"><input className="input" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Lbl>
                <button className="btn" disabled={busy}>Mark as paid</button>
              </form>
            )}
            {r.status === "paid" && <span className="muted text-sm">Paid {r.payDate?.slice(0, 10)}{r.paymentReference ? `, ref ${r.paymentReference}` : ""}</span>}
          </div>
          <div className="card overflow-x-auto" data-server-table>
            <table className="t"><thead><tr><th>Employee</th><th>Days paid</th><th>Unpaid / absent</th><th>Gross</th><th>Deductions</th><th>Net</th><th /></tr></thead>
              <tbody>
                {detail.payslips.map((s) => (
                  <>
                    <tr key={s.id}><td className="font-medium">{s.employeeName}<div className="muted text-xs font-normal">{s.employeeNo} - {s.number.startsWith("DRAFT") ? "draft" : s.number}</div></td><td>{s.daysPayable}/{s.daysInPeriod}</td><td>{s.unpaidDays || s.absentDays ? `${s.unpaidDays} / ${s.absentDays}` : "-"}</td><td>{s.currency} {money(s.gross)}</td><td>{s.deductionsTotal ? money(s.deductionsTotal) : "-"}</td><td className="font-semibold">{s.currency} {money(s.net)}</td>
                      <td className="text-right"><div className="flex justify-end gap-2"><button className="btn-ghost text-xs" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Hide" : "Details"}</button><a className="btn-ghost text-xs" href={`/api/v1/hr/payslips/${s.id}/pdf`}>PDF</a></div></td></tr>
                    {open === s.id && (
                      <tr key={`${s.id}-d`}><td colSpan={7}>
                        <div className="grid gap-4 p-2 text-sm sm:grid-cols-2">
                          <div><b>Added</b>{s.earnings.length === 0 ? <p className="muted">Nothing added.</p> : <ul>{s.earnings.map((x, i) => <li key={i} className="flex justify-between gap-2">{x.name}{x.reason ? <span className="muted text-xs"> ({x.reason})</span> : null}<span>{money(x.amount)}{r.status === "draft" && x.manual && <button className="btn-ghost ml-2 text-xs" onClick={() => run(() => post(`/api/v1/hr/payslips/${s.id}/adjust`, { type: "earning", remove: i }), "Removed.")}>Remove</button>}</span></li>)}</ul>}</div>
                          <div><b>Deducted</b>{s.deductions.length === 0 ? <p className="muted">Nothing deducted.</p> : <ul>{s.deductions.map((x, i) => <li key={i} className="flex justify-between gap-2">{x.name}{x.reason ? <span className="muted text-xs"> ({x.reason})</span> : null}<span>{money(x.amount)}{r.status === "draft" && x.manual && <button className="btn-ghost ml-2 text-xs" onClick={() => run(() => post(`/api/v1/hr/payslips/${s.id}/adjust`, { type: "deduction", remove: i }), "Removed.")}>Remove</button>}</span></li>)}</ul>}</div>
                          {r.status === "draft" && (
                            <form className="flex flex-wrap items-end gap-2 sm:col-span-2" onSubmit={(e) => { e.preventDefault(); void run(() => post(`/api/v1/hr/payslips/${s.id}/adjust`, { type: adj.type, name: adj.name, amount: Number(adj.amount), reason: adj.reason }), "Adjustment added.", () => setAdj({ ...adj, name: "", amount: "", reason: "" })); }}>
                              <Lbl label="Add a line"><select className="input" value={adj.type} onChange={(e) => setAdj({ ...adj, type: e.target.value })}><option value="earning">Bonus or allowance</option><option value="deduction">Deduction</option></select></Lbl>
                              <Lbl label="Name"><input className="input" required value={adj.name} onChange={(e) => setAdj({ ...adj, name: e.target.value })} placeholder="Sales bonus" /></Lbl>
                              <Lbl label="Amount"><input className="input w-32" type="number" min="0.01" step="any" required value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /></Lbl>
                              <Lbl label="Reason"><input className="input" required value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Lbl>
                              <button className="btn-ghost" disabled={busy}>Add</button>
                            </form>
                          )}
                        </div>
                      </td></tr>
                    )}
                  </>
                ))}
                {detail.payslips.length === 0 && <tr><td colSpan={7} className="muted">No payslips: no employee has a salary set for this month.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
