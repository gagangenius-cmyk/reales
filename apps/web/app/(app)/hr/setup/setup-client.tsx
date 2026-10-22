"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lbl, useAction } from "@/components/hr-ui";

interface LT { id?: string; code: string; name: string; annualDays: number; accrual: "upfront" | "monthly"; carryForwardMax: number; paid: boolean; requiresDocumentAfterDays: number; maxConsecutiveDays: number; minNoticeDays: number; gender: "any" | "male" | "female"; countsWeekends: boolean; minServiceMonths: number; active: boolean; color: string | null }
interface Shift { id?: string; name: string; startTime: string; endTime: string; breakMinutes: number; graceMinutes: number; halfDayMinutes: number; weeklyOff: string[]; active: boolean }
interface Hol { id: string; onDate: string; name: string }
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const NEW_TYPE: LT = { code: "", name: "", annualDays: 0, accrual: "upfront", carryForwardMax: 0, paid: true, requiresDocumentAfterDays: 0, maxConsecutiveDays: 0, minNoticeDays: 0, gender: "any", countsWeekends: false, minServiceMonths: 0, active: true, color: "#4f46e5" };
const NEW_SHIFT: Shift = { name: "", startTime: "09:00", endTime: "18:00", breakMinutes: 60, graceMinutes: 10, halfDayMinutes: 240, weeklyOff: ["sat", "sun"], active: true };

export function SetupClient({ types, shifts, holidays, year }: { types: LT[]; shifts: Shift[]; holidays: Hol[]; year: number }) {
  const router = useRouter();
  const { busy, run, Msg, post } = useAction();
  const [t, setT] = useState<LT | null>(null);
  const [s, setS] = useState<Shift | null>(null);
  const [h, setH] = useState({ onDate: "", name: "" });
  const num = (v: string) => (v === "" ? 0 : Number(v));
  return (
    <div className="flex flex-col gap-8">
      <Msg />
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between"><h2 className="text-lg font-semibold">Leave types</h2><button className="btn-ghost" onClick={() => setT({ ...NEW_TYPE })}>+ New leave type</button></div>
        <div className="card overflow-x-auto"><table className="t"><thead><tr><th>Type</th><th>Days / year</th><th>Accrual</th><th>Carry forward</th><th>Rules</th><th>Active</th><th /></tr></thead><tbody>
          {types.map((x) => <tr key={x.id}><td className="font-medium"><span className="mr-2 inline-block h-3 w-3 rounded-sm align-middle" style={{ background: x.color ?? "#999" }} />{x.name}<div className="muted text-xs font-normal">{x.code}{x.paid ? "" : " - unpaid"}</div></td><td>{x.annualDays === 0 && !x.paid ? "Unlimited" : x.annualDays}</td><td>{x.accrual}</td><td>{x.carryForwardMax || "-"}</td>
            <td className="muted text-xs">{[x.gender !== "any" && `${x.gender} only`, x.minNoticeDays > 0 && `${x.minNoticeDays}d notice`, x.maxConsecutiveDays > 0 && `max ${x.maxConsecutiveDays}d`, x.requiresDocumentAfterDays > 0 && `document after ${x.requiresDocumentAfterDays}d`, x.minServiceMonths > 0 && `${x.minServiceMonths}m service`, x.countsWeekends && "counts weekends"].filter(Boolean).join(", ")}</td><td>{x.active ? "Yes" : "No"}</td><td className="text-right"><button className="btn-ghost text-xs" onClick={() => setT(x)}>Edit</button></td></tr>)}
        </tbody></table></div>
        {t && (
          <form className="card grid gap-3 p-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void run(() => post("/api/v1/hr/leave-types", { ...t, color: t.color || null }), "Leave type saved.", () => setT(null)); }}>
            <Lbl label="Code"><input className="input" required pattern="[A-Z0-9_]{2,30}" title="Capitals, digits, underscore" value={t.code} onChange={(e) => setT({ ...t, code: e.target.value.toUpperCase() })} /></Lbl>
            <Lbl label="Name" wide><input className="input" required value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Lbl>
            <Lbl label="Colour"><input className="input h-10" type="color" value={t.color ?? "#4f46e5"} onChange={(e) => setT({ ...t, color: e.target.value })} /></Lbl>
            <Lbl label="Days per year (0 + unpaid = unlimited)"><input className="input" type="number" min="0" step="0.5" value={t.annualDays} onChange={(e) => setT({ ...t, annualDays: num(e.target.value) })} /></Lbl>
            <Lbl label="Earned"><select className="input" value={t.accrual} onChange={(e) => setT({ ...t, accrual: e.target.value as LT["accrual"] })}><option value="upfront">All at the start of the year</option><option value="monthly">Month by month</option></select></Lbl>
            <Lbl label="Carry forward up to (days)"><input className="input" type="number" min="0" step="0.5" value={t.carryForwardMax} onChange={(e) => setT({ ...t, carryForwardMax: num(e.target.value) })} /></Lbl>
            <Lbl label="Applies to"><select className="input" value={t.gender} onChange={(e) => setT({ ...t, gender: e.target.value as LT["gender"] })}><option value="any">Everyone</option><option value="female">Female employees</option><option value="male">Male employees</option></select></Lbl>
            <Lbl label="Notice needed (days)"><input className="input" type="number" min="0" value={t.minNoticeDays} onChange={(e) => setT({ ...t, minNoticeDays: num(e.target.value) })} /></Lbl>
            <Lbl label="Longest single request (days, 0 = no limit)"><input className="input" type="number" min="0" value={t.maxConsecutiveDays} onChange={(e) => setT({ ...t, maxConsecutiveDays: num(e.target.value) })} /></Lbl>
            <Lbl label="Document needed beyond (days)"><input className="input" type="number" min="0" value={t.requiresDocumentAfterDays} onChange={(e) => setT({ ...t, requiresDocumentAfterDays: num(e.target.value) })} /></Lbl>
            <Lbl label="Months of service needed"><input className="input" type="number" min="0" value={t.minServiceMonths} onChange={(e) => setT({ ...t, minServiceMonths: num(e.target.value) })} /></Lbl>
            <div className="flex flex-col justify-end gap-1.5 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={t.paid} onChange={(e) => setT({ ...t, paid: e.target.checked })} />Paid</label><label className="flex items-center gap-2"><input type="checkbox" checked={t.countsWeekends} onChange={(e) => setT({ ...t, countsWeekends: e.target.checked })} />Weekends and holidays count</label><label className="flex items-center gap-2"><input type="checkbox" checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} />Active</label></div>
            <div className="flex gap-2 sm:col-span-4"><button className="btn" disabled={busy}>Save</button><button type="button" className="btn-ghost" onClick={() => setT(null)}>Cancel</button></div>
          </form>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between"><h2 className="text-lg font-semibold">Shifts</h2><button className="btn-ghost" onClick={() => setS({ ...NEW_SHIFT })}>+ New shift</button></div>
        <div className="card overflow-x-auto"><table className="t"><thead><tr><th>Shift</th><th>Hours</th><th>Late after</th><th>Half day under</th><th>Days off</th><th /></tr></thead><tbody>
          {shifts.map((x) => <tr key={x.id}><td className="font-medium">{x.name}{!x.active && <span className="badge badge-gray ml-2">inactive</span>}</td><td>{x.startTime} to {x.endTime}</td><td>{x.graceMinutes} min grace</td><td>{Math.round(x.halfDayMinutes / 60 * 10) / 10} h worked</td><td>{x.weeklyOff.join(", ") || "none"}</td><td className="text-right"><button className="btn-ghost text-xs" onClick={() => setS(x)}>Edit</button></td></tr>)}
        </tbody></table></div>
        {s && (
          <form className="card grid gap-3 p-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void run(() => post("/api/v1/hr/shifts", s), "Shift saved.", () => setS(null)); }}>
            <Lbl label="Name" wide><input className="input" required value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Lbl>
            <Lbl label="Starts"><input className="input" type="time" required value={s.startTime} onChange={(e) => setS({ ...s, startTime: e.target.value })} /></Lbl>
            <Lbl label="Ends"><input className="input" type="time" required value={s.endTime} onChange={(e) => setS({ ...s, endTime: e.target.value })} /></Lbl>
            <Lbl label="Grace before counted late (min)"><input className="input" type="number" min="0" value={s.graceMinutes} onChange={(e) => setS({ ...s, graceMinutes: num(e.target.value) })} /></Lbl>
            <Lbl label="Standard break (min)"><input className="input" type="number" min="0" value={s.breakMinutes} onChange={(e) => setS({ ...s, breakMinutes: num(e.target.value) })} /></Lbl>
            <Lbl label="Half day if worked under (min)"><input className="input" type="number" min="30" value={s.halfDayMinutes} onChange={(e) => setS({ ...s, halfDayMinutes: num(e.target.value) })} /></Lbl>
            <fieldset className="sm:col-span-2"><legend className="muted mb-1 text-xs font-medium">Weekly days off</legend><div className="flex flex-wrap gap-2 text-sm">{DAYS.map((d) => <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={s.weeklyOff.includes(d)} onChange={(e) => setS({ ...s, weeklyOff: e.target.checked ? [...s.weeklyOff, d] : s.weeklyOff.filter((x) => x !== d) })} />{d}</label>)}</div></fieldset>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.active} onChange={(e) => setS({ ...s, active: e.target.checked })} />Active</label>
            <div className="flex gap-2 sm:col-span-4"><button className="btn" disabled={busy}>Save</button><button type="button" className="btn-ghost" onClick={() => setS(null)}>Cancel</button></div>
          </form>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between"><h2 className="text-lg font-semibold">Public holidays {year}</h2><div className="flex gap-2"><button className="btn-ghost" onClick={() => router.push(`/hr/setup?year=${year - 1}`)}>&larr; {year - 1}</button><button className="btn-ghost" onClick={() => router.push(`/hr/setup?year=${year + 1}`)}>{year + 1} &rarr;</button></div></div>
        <form className="card flex flex-wrap items-end gap-3 p-3" onSubmit={(e) => { e.preventDefault(); void run(() => post("/api/v1/hr/holidays", h), "Holiday saved.", () => setH({ onDate: "", name: "" })); }}>
          <Lbl label="Date"><input className="input" type="date" required value={h.onDate} onChange={(e) => setH({ ...h, onDate: e.target.value })} /></Lbl>
          <Lbl label="Name"><input className="input" required value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} placeholder="National Day" /></Lbl>
          <button className="btn" disabled={busy}>Add</button>
        </form>
        <div className="card overflow-x-auto"><table className="t"><tbody>
          {holidays.map((x) => <tr key={x.id}><td className="w-44">{new Date(`${x.onDate.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "long" })}</td><td>{x.name}</td><td className="text-right"><button className="btn-ghost text-xs err" disabled={busy} onClick={() => run(() => post(`/api/v1/hr/holidays/${x.id}`, undefined, "DELETE"), "Removed.")}>Remove</button></td></tr>)}
          {holidays.length === 0 && <tr><td className="muted">No holidays entered for {year}.</td></tr>}
        </tbody></table></div>
      </div>
    </div>
  );
}
