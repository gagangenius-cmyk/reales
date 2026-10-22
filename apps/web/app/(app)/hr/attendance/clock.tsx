"use client";

import { useEffect, useState } from "react";
import { hm, timeDubai, useAction } from "@/components/hr-ui";

export interface Today { linked: boolean; employee?: { name: string }; state?: string; allowed?: boolean; checkInAt?: string | null; checkOutAt?: string | null; lateMinutes?: number; breakMinutes?: number; workedMinutes?: number; openBreak?: { kind: string; startedAt: string } | null; serverTime?: string }

/** Check in / out and breaks with live running timers. State is re-read from the server every 30 seconds and after every action. */
export function Clock({ initial }: { initial: Today }) {
  const { busy, run, Msg, post } = useAction();
  const [t, setT] = useState<Today>(initial);
  const [now, setNow] = useState(() => (initial.serverTime ? Date.parse(initial.serverTime) : Date.now()));
  const [kind, setKind] = useState("lunch");
  useEffect(() => { setT(initial); if (initial.serverTime) setNow(Date.parse(initial.serverTime)); }, [initial]);
  useEffect(() => { const i = setInterval(() => setNow((n) => n + 1000), 1000); return () => clearInterval(i); }, []);
  useEffect(() => {
    const i = setInterval(async () => { try { const r = await fetch("/api/v1/hr/me", { cache: "no-store" }); if (r.ok) { const j = await r.json(); if (j.today) { setT(j.today); setNow(Date.parse(j.today.serverTime)); } } } catch { /* offline: keep the last state */ } }, 30000);
    return () => clearInterval(i);
  }, []);
  if (!t.linked) return <div className="card p-4 text-sm"><b>Attendance</b><p className="muted">Your login is not linked to an employee record yet. Ask HR to link it so you can check in.</p></div>;

  const onBreak = t.openBreak ? Math.floor((now - Date.parse(t.openBreak.startedAt)) / 1000) : 0;
  const worked = t.checkInAt && !t.checkOutAt ? Math.max(0, Math.round((now - Date.parse(t.checkInAt)) / 60000) - (t.breakMinutes ?? 0) - Math.round(onBreak / 60)) : t.workedMinutes ?? 0;
  const label: Record<string, string> = { not_started: "Not checked in", working: "Working", on_break: "On a break", done: "Done for today", on_leave: "On leave" };
  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><b>Hello{t.employee?.name ? `, ${t.employee.name.split(" ")[0]}` : ""}</b><p className="muted text-xs">{new Date(now).toLocaleString("en-GB", { timeZone: "Asia/Dubai", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", second: "2-digit" })} (Dubai)</p></div>
        <span className={`badge ${t.state === "working" ? "badge-ok" : t.state === "on_break" ? "badge-warn" : "badge-gray"}`}>{label[t.state ?? "not_started"]}</span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-center text-sm">
        <div className="rounded-lg p-3" style={{ background: "var(--card-2)" }}><div className="muted text-xs">In</div><b>{timeDubai(t.checkInAt ?? null)}</b>{(t.lateMinutes ?? 0) > 0 && <div className="err text-xs">{t.lateMinutes} min late</div>}</div>
        <div className="rounded-lg p-3" style={{ background: "var(--card-2)" }}><div className="muted text-xs">Worked</div><b>{hm(worked)}</b></div>
        <div className="rounded-lg p-3" style={{ background: "var(--card-2)" }}><div className="muted text-xs">Breaks</div><b>{hm((t.breakMinutes ?? 0) + Math.round(onBreak / 60))}</b></div>
      </div>
      {t.openBreak && <p className="text-sm">On {t.openBreak.kind} break for <b>{Math.floor(onBreak / 60)}:{String(onBreak % 60).padStart(2, "0")}</b></p>}
      {!t.allowed && <p className="muted text-xs">Check-in from the CRM is switched off for your company.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {t.state === "not_started" && <button className="btn" disabled={busy || !t.allowed} onClick={() => run(() => post("/api/v1/hr/attendance/check-in", {}), "Checked in.")}>Check in</button>}
        {t.state === "working" && (
          <>
            <select className="input w-auto py-1.5" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Break type"><option value="lunch">Lunch</option><option value="tea">Tea</option><option value="prayer">Prayer</option><option value="other">Other</option></select>
            <button className="btn-ghost" disabled={busy} onClick={() => run(() => post("/api/v1/hr/attendance/break", { kind }), "Break started.")}>Start break</button>
            <button className="btn" disabled={busy} onClick={() => run(() => post("/api/v1/hr/attendance/check-out", {}), "Checked out. See you tomorrow.")}>Check out</button>
          </>
        )}
        {t.state === "on_break" && <button className="btn" disabled={busy} onClick={() => run(() => post("/api/v1/hr/attendance/break", undefined, "DELETE"), "Back to work.")}>End break</button>}
      </div>
      <Msg />
    </div>
  );
}
