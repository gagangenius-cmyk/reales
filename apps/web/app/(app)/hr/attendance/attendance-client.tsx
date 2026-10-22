"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { dayDubai, hm, Lbl, timeDubai, useAction } from "@/components/hr-ui";

interface Person { id: string; name: string; no: string; designation: string | null; department: string | null; state: string; checkInAt: string | null; checkOutAt: string | null; late: number; breakKind: string | null; breakStartedAt: string | null; workedMinutes: number }
interface Board { date: string; serverTime: string; holiday: string | null; totals: Record<string, number>; people: Person[] }
const STATE: Record<string, { label: string; cls: string }> = { working: { label: "Working", cls: "badge-ok" }, on_break: { label: "On break", cls: "badge-warn" }, done: { label: "Checked out", cls: "badge-gray" }, on_leave: { label: "On leave", cls: "" }, not_in: { label: "Not in yet", cls: "badge-gray" }, holiday: { label: "Holiday", cls: "" }, weekly_off: { label: "Day off", cls: "" } };

/** Everyone's state right now. Refreshes itself every 15 seconds; breaks show a live timer. */
export function LiveBoard({ initial }: { initial: Board }) {
  const [b, setB] = useState(initial);
  const [now, setNow] = useState(Date.parse(initial.serverTime));
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  useEffect(() => { const i = setInterval(() => setNow((n) => n + 1000), 1000); return () => clearInterval(i); }, []);
  useEffect(() => {
    const i = setInterval(async () => { try { const r = await fetch("/api/v1/hr/attendance/live", { cache: "no-store" }); if (r.ok) { const j = await r.json(); setB(j); setNow(Date.parse(j.serverTime)); } } catch { /* keep last */ } }, 15000);
    return () => clearInterval(i);
  }, []);
  const people = b.people.filter((p) => (filter === "all" || p.state === filter) && (!q || `${p.name} ${p.no} ${p.department ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  const chips: [string, string, number][] = [["all", "Everyone", b.totals.employees ?? 0], ["working", "Working", b.totals.working ?? 0], ["on_break", "On break", b.totals.onBreak ?? 0], ["done", "Checked out", b.totals.done ?? 0], ["on_leave", "On leave", b.totals.onLeave ?? 0], ["not_in", "Not in", b.totals.notIn ?? 0]];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Live board <span className="muted text-sm font-normal">{b.holiday ? `Public holiday: ${b.holiday}` : dayDubai(b.date)}</span></h2><input className="input w-56" type="search" placeholder="Find an employee" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find an employee" /></div>
      <div className="flex flex-wrap gap-2 text-sm">{chips.map(([k, l, n]) => <button key={k} className={filter === k ? "btn" : "btn-ghost"} onClick={() => setFilter(k)}>{l} ({n})</button>)}</div>
      <div className="card overflow-x-auto" data-server-table>
        <table className="t"><thead><tr><th>Employee</th><th>Department</th><th>Status</th><th>In</th><th>Out</th><th>Worked</th><th>Late</th></tr></thead>
          <tbody>
            {people.map((p) => {
              const s = STATE[p.state] ?? STATE.not_in!;
              const bs = p.breakStartedAt ? Math.floor((now - Date.parse(p.breakStartedAt)) / 1000) : 0;
              const live = p.state === "working" && p.checkInAt ? Math.max(0, Math.round((now - Date.parse(p.checkInAt)) / 60000)) : p.workedMinutes;
              return (
                <tr key={p.id}>
                  <td className="font-medium">{p.name}<div className="muted text-xs font-normal">{p.no}{p.designation ? ` - ${p.designation}` : ""}</div></td><td>{p.department ?? "-"}</td>
                  <td><span className={`badge ${s.cls}`}>{s.label}</span>{p.state === "on_break" && <div className="muted text-xs">{p.breakKind} {Math.floor(bs / 60)}:{String(bs % 60).padStart(2, "0")}</div>}</td>
                  <td>{timeDubai(p.checkInAt)}</td><td>{timeDubai(p.checkOutAt)}</td><td>{p.checkInAt ? hm(live) : "-"}</td><td className={p.late ? "err" : ""}>{p.late ? `${p.late} min` : "-"}</td>
                </tr>
              );
            })}
            {people.length === 0 && <tr><td colSpan={7} className="muted">Nobody matches.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Day { date: string; status: string; checkInAt: string | null; checkOutAt: string | null; workedMinutes: number; breakMinutes: number; lateMinutes: number; note: string | null }
const DAYCLS: Record<string, string> = { present: "badge-ok", late: "badge-warn", half_day: "badge-warn", absent: "err", on_leave: "", holiday: "", weekly_off: "badge-gray", upcoming: "badge-gray", not_in: "badge-gray" };

export function TimesheetView({ sheet, employees, selected, from, to, canPick, canCorrect }: { sheet: { employee: { id: string; name: string }; days: Day[]; summary: Record<string, number> } | null; employees: { id: string; name: string }[]; selected: string; from: string; to: string; canPick: boolean; canCorrect: boolean }) {
  const router = useRouter();
  const [f, setF] = useState({ employee: selected, from, to });
  const [fix, setFix] = useState<Day | null>(null);
  const [v, setV] = useState({ inT: "", outT: "", status: "", reason: "" });
  const { busy, run, Msg, post } = useAction();
  const go = (e: React.FormEvent) => { e.preventDefault(); router.push(`/hr/attendance?${new URLSearchParams({ ...(f.employee ? { employee: f.employee } : {}), from: f.from, to: f.to })}`); };
  const toIso = (date: string, t: string) => (t ? new Date(`${date}T${t}:00+04:00`).toISOString() : null);
  const hhmm = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 4 * 3_600_000).toISOString().slice(11, 16) : "");
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Daily record</h2>
      <form onSubmit={go} className="card flex flex-wrap items-end gap-3 p-3">
        {canPick && <Lbl label="Employee"><select className="input" value={f.employee} onChange={(e) => setF({ ...f, employee: e.target.value })}>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Lbl>}
        <Lbl label="From"><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Lbl>
        <Lbl label="To"><input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Lbl>
        <button className="btn">Show</button>
      </form>
      {!sheet ? <p className="muted text-sm">No employee record to show.</p> : (
        <>
          <div className="grid gap-3 sm:grid-cols-5">{([["Present", sheet.summary.present], ["Late", sheet.summary.late], ["Half days", sheet.summary.halfDays], ["Absent", sheet.summary.absent], ["Hours worked", sheet.summary.workedHours]] as [string, number][]).map(([l, n]) => <div key={l} className="card stat"><span className="muted text-xs">{l}</span><b>{n}</b></div>)}</div>
          <Msg />
          {fix && canCorrect && (
            <form className="card grid gap-3 p-4 sm:grid-cols-4" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => post("/api/v1/hr/attendance/correct", { employeeId: sheet.employee.id, date: fix.date, checkInAt: toIso(fix.date, v.inT), checkOutAt: toIso(fix.date, v.outT), ...(v.status ? { status: v.status } : {}), reason: v.reason }), "Corrected."); if (ok) setFix(null); }}>
              <h3 className="font-semibold sm:col-span-4">Correct {dayDubai(fix.date)}</h3>
              <Lbl label="Check-in (Dubai)"><input className="input" type="time" value={v.inT} onChange={(e) => setV({ ...v, inT: e.target.value })} /></Lbl>
              <Lbl label="Check-out (Dubai)"><input className="input" type="time" value={v.outT} onChange={(e) => setV({ ...v, outT: e.target.value })} /></Lbl>
              <Lbl label="Status"><select className="input" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}><option value="">Work it out from the times</option><option value="present">Present</option><option value="late">Late</option><option value="half_day">Half day</option><option value="absent">Absent</option><option value="on_leave">On leave</option></select></Lbl>
              <Lbl label="Reason (required)"><input className="input" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} required /></Lbl>
              <div className="flex gap-2 sm:col-span-4"><button className="btn" disabled={busy || !v.reason.trim()}>Save correction</button><button type="button" className="btn-ghost" onClick={() => setFix(null)}>Cancel</button></div>
            </form>
          )}
          <div className="card overflow-x-auto" data-server-table>
            <table className="t"><thead><tr><th>Date</th><th>Status</th><th>In</th><th>Out</th><th>Breaks</th><th>Worked</th><th>Note</th>{canCorrect && <th />}</tr></thead>
              <tbody>{sheet.days.map((d) => (
                <tr key={d.date}><td>{dayDubai(d.date)}</td><td><span className={`badge ${DAYCLS[d.status] ?? ""}`}>{d.status.replace("_", " ")}</span>{d.lateMinutes > 0 && <span className="muted ml-1 text-xs">{d.lateMinutes}m late</span>}</td><td>{timeDubai(d.checkInAt)}</td><td>{timeDubai(d.checkOutAt)}</td><td>{d.breakMinutes ? hm(d.breakMinutes) : "-"}</td><td>{d.workedMinutes ? hm(d.workedMinutes) : "-"}</td><td className="muted max-w-xs truncate text-xs">{d.note}</td>
                  {canCorrect && <td className="text-right"><button className="btn-ghost text-xs" onClick={() => { setFix(d); setV({ inT: hhmm(d.checkInAt), outT: hhmm(d.checkOutAt), status: "", reason: "" }); }}>Correct</button></td>}</tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
