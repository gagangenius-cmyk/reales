"use client";

import { useState } from "react";
import { Lbl, useAction } from "@/components/hr-ui";

interface Sal { id: string; effectiveFrom: string; currency: string; basic: number; housing: number; transport: number; otherAllowance: number; gross: number; paymentMethod: string; iban: string | null; reason: string | null; current: boolean; components: { name: string; type: string; amount: number }[] }
const money = (n: number, c: string) => `${c} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function SalaryPanel({ employeeId, history, canEdit }: { employeeId: string; history: Sal[]; canEdit: boolean }) {
  const { busy, run, Msg, post } = useAction();
  const cur = history.find((h) => h.current) ?? history[0];
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ effectiveFrom: new Date().toISOString().slice(0, 10), basic: String(cur?.basic ?? ""), housing: String(cur?.housing ?? ""), transport: String(cur?.transport ?? ""), other: String(cur?.otherAllowance ?? ""), paymentMethod: cur?.paymentMethod ?? "bank_transfer", iban: "", reason: "" });
  const n = (s: string) => (s === "" ? 0 : Number(s));
  const gross = n(v.basic) + n(v.housing) + n(v.transport) + n(v.other);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (await run(() => post(`/api/v1/hr/employees/${employeeId}/salary`, { effectiveFrom: v.effectiveFrom, basic: n(v.basic), housing: n(v.housing), transport: n(v.transport), otherAllowance: n(v.other), paymentMethod: v.paymentMethod, ...(v.iban.trim() ? { iban: v.iban.trim() } : {}), ...(v.reason.trim() ? { reason: v.reason.trim() } : {}) }, "PUT"), "Salary saved.")) setOpen(false);
  }
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-baseline justify-between"><h2 className="font-semibold">Salary <span className="muted text-xs font-normal">confidential</span></h2>{canEdit && <button className="btn-ghost text-xs" onClick={() => setOpen(!open)}>{open ? "Close" : cur ? "Revise salary" : "Set salary"}</button>}</div>
      {cur ? (
        <div className="grid gap-3 text-sm sm:grid-cols-5">{([["Basic", cur.basic], ["Housing", cur.housing], ["Transport", cur.transport], ["Other", cur.otherAllowance], ["Gross / month", cur.gross]] as [string, number][]).map(([l, a]) => <div key={l} className="rounded-lg p-3" style={{ background: "var(--card-2)" }}><div className="muted text-xs">{l}</div><b>{money(a, cur.currency)}</b></div>)}</div>
      ) : <p className="muted text-sm">No salary set.</p>}
      {cur && <p className="muted mt-2 text-xs">Paid by {cur.paymentMethod.replace("_", " ")}{cur.iban ? `, account ${cur.iban}` : ""}. Effective {cur.effectiveFrom.slice(0, 10)}.</p>}
      {open && (
        <form onSubmit={save} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-4" style={{ borderColor: "var(--border)" }}>
          <Lbl label="Effective from"><input className="input" type="date" required value={v.effectiveFrom} onChange={(e) => setV({ ...v, effectiveFrom: e.target.value })} /></Lbl>
          <Lbl label="Basic"><input className="input" type="number" min="1" step="any" required value={v.basic} onChange={(e) => setV({ ...v, basic: e.target.value })} /></Lbl>
          <Lbl label="Housing"><input className="input" type="number" min="0" step="any" value={v.housing} onChange={(e) => setV({ ...v, housing: e.target.value })} /></Lbl>
          <Lbl label="Transport"><input className="input" type="number" min="0" step="any" value={v.transport} onChange={(e) => setV({ ...v, transport: e.target.value })} /></Lbl>
          <Lbl label="Other allowances"><input className="input" type="number" min="0" step="any" value={v.other} onChange={(e) => setV({ ...v, other: e.target.value })} /></Lbl>
          <Lbl label="Paid by"><select className="input" value={v.paymentMethod} onChange={(e) => setV({ ...v, paymentMethod: e.target.value })}><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="cheque">Cheque</option></select></Lbl>
          <Lbl label="IBAN (kept encrypted)"><input className="input" value={v.iban} onChange={(e) => setV({ ...v, iban: e.target.value })} placeholder="Leave blank to keep the current one" /></Lbl>
          <Lbl label="Reason for change"><input className="input" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="Annual review" /></Lbl>
          <div className="flex items-center gap-3 sm:col-span-4"><span className="text-sm">Gross: <b>{gross.toLocaleString("en-US")}</b></span><button className="btn" disabled={busy}>Save</button></div>
        </form>
      )}
      <Msg />
      {history.length > 1 && (
        <details className="mt-3"><summary className="cursor-pointer text-sm">History ({history.length})</summary>
          <table className="t mt-2"><thead><tr><th>From</th><th>Gross</th><th>Reason</th></tr></thead><tbody>{history.map((h) => <tr key={h.id}><td>{h.effectiveFrom.slice(0, 10)}{h.current && <span className="badge badge-ok ml-2">current</span>}</td><td>{money(h.gross, h.currency)}</td><td className="muted text-xs">{h.reason}</td></tr>)}</tbody></table>
        </details>
      )}
    </div>
  );
}

export function BalanceAdjust({ employeeId, types }: { employeeId: string; types: { id: string; name: string }[] }) {
  const { busy, run, Msg, post } = useAction();
  const [v, setV] = useState({ leaveTypeId: types[0]?.id ?? "", delta: "", note: "" });
  if (!types.length) return null;
  return (
    <form className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3 text-sm" style={{ borderColor: "var(--border)" }} onSubmit={(e) => { e.preventDefault(); void run(() => post(`/api/v1/hr/employees/${employeeId}/leave-balances`, { leaveTypeId: v.leaveTypeId, year: new Date().getFullYear(), adjusted: Number(v.delta), note: v.note }), "Balance adjusted."); }}>
      <Lbl label="Adjust balance"><select className="input" value={v.leaveTypeId} onChange={(e) => setV({ ...v, leaveTypeId: e.target.value })}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Lbl>
      <Lbl label="Days (+/-)"><input className="input w-24" type="number" step="0.5" required value={v.delta} onChange={(e) => setV({ ...v, delta: e.target.value })} /></Lbl>
      <Lbl label="Reason"><input className="input" required value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Lbl>
      <button className="btn-ghost" disabled={busy || !v.delta || !v.note.trim()}>Apply</button><Msg />
    </form>
  );
}
