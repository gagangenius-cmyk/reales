"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Win = { weekday: number; startTime: string; endTime: string };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDER = [1, 2, 3, 4, 5, 6, 0]; // show Monday first

export function WeeklyEditor({ userId, initial, canEdit }: { userId: string; initial: Win[]; canEdit: boolean }) {
  const router = useRouter();
  const [wins, setWins] = useState<Win[]>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (i: number, k: "startTime" | "endTime", v: string) => setWins(wins.map((w, j) => (j === i ? { ...w, [k]: v } : w)));
  const preset = () => setWins([1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "18:00" })));
  async function save() {
    setBusy(true); setMsg(null);
    const r = await postJson(`/api/v1/availability/${userId}`, { windows: wins }, "PUT");
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMsg({ ok: true, text: wins.length ? "Working hours saved. Viewings can only be booked inside them." : "No working hours set: viewings can be booked at any time." });
    router.refresh();
  }
  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="font-semibold">Weekly working hours</h2><p className="muted text-xs">Dubai time (UTC+4). Leave every day empty for no restriction.</p></div>
        {canEdit && <button type="button" className="btn-ghost text-xs" onClick={preset}>Mon-Fri 09:00-18:00</button>}
      </div>
      <ul className="flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>
        {ORDER.map((d) => {
          const rows = wins.map((w, i) => ({ w, i })).filter((x) => x.w.weekday === d);
          return (
            <li key={d} className="flex flex-wrap items-center gap-3 py-2.5">
              <span className="w-28 text-sm font-medium">{DAYS[d]}</span>
              <div className="flex flex-1 flex-col gap-1.5">
                {rows.length === 0 && <span className="muted text-sm">Unavailable</span>}
                {rows.map(({ w, i }) => (
                  <div key={i} className="flex items-center gap-2">
                    <input type="time" className="input w-32 py-1" disabled={!canEdit} value={w.startTime} onChange={(e) => upd(i, "startTime", e.target.value)} aria-label={`${DAYS[d]} start`} />
                    <span className="muted">to</span>
                    <input type="time" className="input w-32 py-1" disabled={!canEdit} value={w.endTime} onChange={(e) => upd(i, "endTime", e.target.value)} aria-label={`${DAYS[d]} end`} />
                    {canEdit && <button type="button" className="btn-ghost text-xs" aria-label="Remove window" onClick={() => setWins(wins.filter((_, j) => j !== i))}>&times;</button>}
                  </div>
                ))}
              </div>
              {canEdit && <button type="button" className="btn-ghost text-xs" onClick={() => setWins([...wins, { weekday: d, startTime: rows.length ? rows[rows.length - 1]!.w.endTime : "09:00", endTime: "18:00" }])}>+ Add hours</button>}
            </li>
          );
        })}
      </ul>
      {canEdit && <div className="mt-4 flex items-center gap-3"><button className="btn" disabled={busy} onClick={save}>{busy ? "Saving..." : "Save working hours"}</button>{msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p>}</div>}
    </div>
  );
}

export function TimeOffPanel({ userId, items, canEdit }: { userId: string; items: { id: string; startsAt: string; endsAt: string; reason: string | null }[]; canEdit: boolean }) {
  const router = useRouter();
  const [f, setF] = useState({ startsAt: "", endsAt: "", reason: "" });
  const [msg, setMsg] = useState<string | null>(null);
  async function add(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    // datetime-local has no zone: read it as Dubai time.
    const r = await postJson(`/api/v1/availability/${userId}`, { startsAt: new Date(`${f.startsAt}:00+04:00`).toISOString(), endsAt: new Date(`${f.endsAt}:00+04:00`).toISOString(), reason: f.reason || undefined });
    if (!r.ok) return setMsg(errMsg(r));
    setF({ startsAt: "", endsAt: "", reason: "" });
    router.refresh();
  }
  const fmt = (s: string) => new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="card p-4">
      <h2 className="font-semibold">Time off</h2><p className="muted mb-3 text-xs">Leave, training or blocked time. No viewings can be booked then.</p>
      <ul className="mb-4 flex flex-col gap-2 text-sm">
        {items.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-2 rounded-lg border p-2.5" style={{ borderColor: "var(--border)" }}>
            <span>{fmt(t.startsAt)} &ndash; {fmt(t.endsAt)}{t.reason && <span className="muted"> &middot; {t.reason}</span>}</span>
            {canEdit && <button className="btn-ghost text-xs" onClick={async () => { await postJson(`/api/v1/availability/time-off/${t.id}`, undefined, "DELETE"); router.refresh(); }}>Remove</button>}
          </li>
        ))}
        {items.length === 0 && <li className="muted">None scheduled.</li>}
      </ul>
      {canEdit && (
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">From</span><input type="datetime-local" className="input" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} required /></label>
          <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">To</span><input type="datetime-local" className="input" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} required /></label>
          <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Reason</span><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Annual leave" /></label>
          <div className="flex items-center gap-3 sm:col-span-3"><button className="btn">Add time off</button><p role="alert" className="err text-sm">{msg}</p></div>
        </form>
      )}
    </div>
  );
}

export function SlotFinder({ agents }: { agents: { id: string; email: string }[] }) {
  const [agent, setAgent] = useState(agents[0]?.id ?? "");
  const [date, setDate] = useState(new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10));
  const [duration, setDuration] = useState("30");
  const [slots, setSlots] = useState<string[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  async function find() {
    setNote(null); setSlots(null);
    const res = await fetch(`/api/v1/availability/slots?agentUserId=${agent}&date=${date}&durationMin=${duration}`);
    const j = await res.json();
    if (!res.ok) return setNote(j?.error?.message ?? "Could not load slots");
    setSlots(j.slots); setNote(j.restricted ? null : "This agent has no working hours set, so the default 09:00-18:00 day is shown.");
  }
  const hm = (s: string) => new Date(s).toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="card p-4">
      <h2 className="font-semibold">Find a free slot</h2><p className="muted mb-3 text-xs">Shows start times that are inside working hours and clear of time off and other viewings.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Agent</span><select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>{agents.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</select></label>
        <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Date</span><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Length</span><select className="input" value={duration} onChange={(e) => setDuration(e.target.value)}><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option></select></label>
        <button className="btn" onClick={find}>Show slots</button>
      </div>
      {note && <p className="muted mt-3 text-xs">{note}</p>}
      {slots && <div className="mt-3 flex flex-wrap gap-2">{slots.map((s) => <span key={s} className="badge">{hm(s)}</span>)}{slots.length === 0 && <span className="muted text-sm">No free slots that day.</span>}</div>}
    </div>
  );
}
