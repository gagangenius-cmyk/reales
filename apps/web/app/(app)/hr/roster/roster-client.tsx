"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lbl, useAction } from "@/components/hr-ui";

interface Day { date: string; off: boolean; shift: string | null; rostered: boolean; note: string | null }
interface Row { employeeId: string; name: string; no: string; defaultShift: string | null; days: Day[] }
const WEEK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const shiftDay = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function RosterClient({ rows, shifts, from, to, canManage }: { rows: Row[]; shifts: { id: string; name: string }[]; from: string; to: string; canManage: boolean }) {
  const router = useRouter();
  const { busy, run, Msg, post } = useAction();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [f, setF] = useState({ from, to, shiftId: shifts[0]?.id ?? "", mode: "shift", weekdays: [] as string[], note: "" });
  const dates = rows[0]?.days.map((d) => d.date) ?? [];
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2"><button className="btn-ghost" onClick={() => router.push(`/hr/roster?from=${shift(from, -14)}`)}>&larr; Earlier</button><button className="btn-ghost" onClick={() => router.push("/hr/roster")}>Today</button><button className="btn-ghost" onClick={() => router.push(`/hr/roster?from=${shift(from, 14)}`)}>Later &rarr;</button><span className="muted text-sm">{shiftDay(from)} to {shiftDay(to)}</span></div>
      <Msg />
      {canManage && (
        <form className="card grid gap-3 p-4 text-sm sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void run(() => post("/api/v1/hr/roster", { employeeIds: [...sel], from: f.from, to: f.to, ...(f.mode === "off" ? { dayOff: true } : { shiftId: f.shiftId }), ...(f.weekdays.length ? { weekdays: f.weekdays } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}) }), "Roster saved.", () => setSel(new Set())); }}>
          <h2 className="font-semibold sm:col-span-4">Roster the {sel.size} selected employee{sel.size === 1 ? "" : "s"}</h2>
          <Lbl label="From"><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Lbl>
          <Lbl label="To"><input className="input" type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></Lbl>
          <Lbl label="Put them on"><select className="input" value={f.mode === "off" ? "off" : f.shiftId} onChange={(e) => setF(e.target.value === "off" ? { ...f, mode: "off" } : { ...f, mode: "shift", shiftId: e.target.value })}>{shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="off">A day off</option></select></Lbl>
          <Lbl label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Swapped weekend" /></Lbl>
          <fieldset className="sm:col-span-4"><legend className="muted mb-1 text-xs font-medium">Only on these weekdays (none ticked = every day)</legend><div className="flex flex-wrap gap-3">{WEEK.map((d) => <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={f.weekdays.includes(d)} onChange={(e) => setF({ ...f, weekdays: e.target.checked ? [...f.weekdays, d] : f.weekdays.filter((x) => x !== d) })} />{d}</label>)}</div></fieldset>
          <div className="flex gap-2 sm:col-span-4"><button className="btn" disabled={busy || sel.size === 0}>Save roster</button><button type="button" className="btn-ghost" disabled={busy || sel.size === 0} onClick={() => confirm("Remove the roster for these dates so they follow their normal shift?") && run(() => post("/api/v1/hr/roster", { employeeIds: [...sel], from: f.from, to: f.to }, "DELETE"), "Back to the normal shift.", () => setSel(new Set()))}>Clear roster for these dates</button></div>
        </form>
      )}
      <div className="card overflow-x-auto" data-server-table>
        <table className="t">
          <thead><tr>{canManage && <th className="w-8" />}<th>Employee</th>{dates.map((d) => <th key={d} className="whitespace-nowrap text-xs">{shiftDay(d)}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.employeeId}>
                {canManage && <td><input type="checkbox" aria-label={`Select ${r.name}`} checked={sel.has(r.employeeId)} onChange={() => toggle(r.employeeId)} /></td>}
                <td className="whitespace-nowrap font-medium">{r.name}<div className="muted text-xs font-normal">{r.defaultShift ?? "Default shift"}</div></td>
                {r.days.map((d) => <td key={d.date} className="text-center text-xs" title={d.note ?? undefined} style={{ background: d.off ? "var(--card-2)" : d.rostered ? "color-mix(in srgb, var(--accent) 14%, transparent)" : undefined }}>{d.off ? <span className="muted">Off</span> : <span>{d.shift ? d.shift.split(" ")[0] : "-"}</span>}{d.rostered && <span className="ml-0.5">*</span>}</td>)}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={16} className="muted">No employees to show.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted text-xs">* rostered for that date, overriding the usual pattern. Shaded grey: day off.</p>
    </div>
  );
}
