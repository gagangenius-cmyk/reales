"use client";

import { useState } from "react";
import { dayDubai, Lbl, useAction } from "@/components/hr-ui";

interface Bal { leaveTypeId: string; code: string; name: string; color: string | null; unlimited: boolean; entitled: number; carried: number; adjusted: number; taken: number; pending: number; available: number | null }
interface Type { id: string; code: string; name: string; gender: string }
interface Req { id: string; employeeName: string; employeeNo: string; typeName: string; typeColor: string | null; fromDate: string; toDate: string; days: number; halfDay: string; status: string; reason: string | null; decisionNote: string | null; canDecide: boolean; canCancel: boolean }
interface Cal { fromDate: string; toDate: string; days: number; name: string; type: string; color: string | null }
const badge = (s: string) => (s === "approved" ? "badge-ok" : s === "pending" ? "badge-warn" : "badge-gray");

export function LeaveClient({ linked, balances, types, mine, approvals, calendar, month }: { linked: boolean; balances: Bal[]; types: Type[]; mine: Req[]; approvals: Req[]; calendar: Cal[]; month: string }) {
  const { busy, run, Msg, post } = useAction();
  const [f, setF] = useState({ leaveTypeId: types[0]?.id ?? "", fromDate: "", toDate: "", halfDay: "none", reason: "" });
  const [note, setNote] = useState<Record<string, string>>({});
  const submit = async (e: React.FormEvent) => { e.preventDefault(); if (await run(() => post("/api/v1/hr/leave", { ...f, reason: f.reason.trim() || undefined }), "Leave requested.")) setF({ ...f, fromDate: "", toDate: "", reason: "", halfDay: "none" }); };
  return (
    <div className="flex flex-col gap-6">
      <Msg />
      {!linked && <p className="card p-4 text-sm">Your login is not linked to an employee record, so you cannot request leave. Ask HR.</p>}
      {linked && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {balances.map((b) => (
              <div key={b.leaveTypeId} className="card p-4" style={{ borderTop: `3px solid ${b.color ?? "var(--accent)"}` }}>
                <div className="muted text-xs">{b.name}</div>
                <div className="text-2xl font-semibold">{b.unlimited ? "Unlimited" : b.available}<span className="muted ml-1 text-xs font-normal">{b.unlimited ? "" : "days left"}</span></div>
                {!b.unlimited && <div className="muted text-xs">{b.entitled} earned{b.carried ? ` + ${b.carried} carried` : ""}{b.adjusted ? ` ${b.adjusted > 0 ? "+" : ""}${b.adjusted} adjusted` : ""}, {b.taken} taken{b.pending ? `, ${b.pending} pending` : ""}</div>}
              </div>
            ))}
          </div>
          <form onSubmit={submit} className="card grid gap-3 p-4 sm:grid-cols-4">
            <h2 className="font-semibold sm:col-span-4">Request leave</h2>
            <Lbl label="Type"><select className="input" value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Lbl>
            <Lbl label="From"><input className="input" type="date" required value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value, toDate: f.toDate || e.target.value })} /></Lbl>
            <Lbl label="To"><input className="input" type="date" required min={f.fromDate} value={f.toDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} /></Lbl>
            <Lbl label="Half day"><select className="input" value={f.halfDay} onChange={(e) => setF({ ...f, halfDay: e.target.value })}><option value="none">No</option><option value="first">First half</option><option value="second">Second half</option></select></Lbl>
            <Lbl label="Reason" wide><input className="input" maxLength={500} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Lbl>
            <div className="sm:col-span-2 flex items-end"><button className="btn" disabled={busy || !f.leaveTypeId}>Send request</button></div>
          </form>
        </>
      )}
      {approvals.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Waiting for your decision</h2>
          <div className="card overflow-x-auto" data-server-table>
            <table className="t"><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th>Decision</th></tr></thead>
              <tbody>{approvals.map((r) => (
                <tr key={r.id}><td className="font-medium">{r.employeeName}<div className="muted text-xs font-normal">{r.employeeNo}</div></td><td>{r.typeName}</td><td>{dayDubai(r.fromDate)}{r.toDate !== r.fromDate && <> to {dayDubai(r.toDate)}</>}</td><td>{r.days}</td><td className="max-w-xs text-xs">{r.reason}</td>
                  <td>{r.canDecide ? <div className="flex flex-wrap items-center gap-2"><input className="input w-40 py-1" placeholder="Note (needed to reject)" value={note[r.id] ?? ""} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} /><button className="btn text-xs" disabled={busy} onClick={() => run(() => post(`/api/v1/hr/leave/${r.id}/decide`, { approve: true, note: note[r.id] || undefined }), "Approved.")}>Approve</button><button className="btn-ghost text-xs err" disabled={busy || !(note[r.id] ?? "").trim()} onClick={() => run(() => post(`/api/v1/hr/leave/${r.id}/decide`, { approve: false, note: note[r.id] }), "Rejected.")}>Reject</button></div> : <span className="muted text-xs">Not yours to decide</span>}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
      {linked && (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">My requests</h2>
          <div className="card overflow-x-auto" data-server-table>
            <table className="t"><thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Note</th><th /></tr></thead>
              <tbody>
                {mine.map((r) => <tr key={r.id}><td>{r.typeName}</td><td>{dayDubai(r.fromDate)}{r.toDate !== r.fromDate && <> to {dayDubai(r.toDate)}</>}{r.halfDay !== "none" && <span className="muted text-xs"> ({r.halfDay} half)</span>}</td><td>{r.days}</td><td><span className={`badge ${badge(r.status)}`}>{r.status}</span></td><td className="max-w-xs text-xs">{r.decisionNote ?? r.reason}</td><td className="text-right">{r.canCancel && <button className="btn-ghost text-xs" disabled={busy} onClick={() => confirm("Cancel this leave?") && run(() => post(`/api/v1/hr/leave/${r.id}/cancel`, {}), "Cancelled.")}>Cancel</button>}</td></tr>)}
                {mine.length === 0 && <tr><td colSpan={6} className="muted">No requests yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {calendar.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Who is away in {month}</h2>
          <ul className="card flex flex-col gap-1.5 p-4 text-sm">{calendar.map((c, i) => <li key={i} className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: c.color ?? "var(--accent)" }} /><b>{c.name}</b><span className="muted">{c.type}, {dayDubai(c.fromDate)}{c.toDate !== c.fromDate && <> to {dayDubai(c.toDate)}</>} ({c.days} d)</span></li>)}</ul>
        </div>
      )}
    </div>
  );
}
