"use client";

import { useState } from "react";
import { Lbl, useAction } from "@/components/hr-ui";

interface News { id: string; title: string; body: string; pinned: boolean; publishAt: string; expiresAt: string | null }
interface Party { kind: string; date: string; daysAway: number; title: string; detail?: string }
const KIND: Record<string, string> = { birthday: "Birthday", anniversary: "Work anniversary", new_joiner: "New joiner", occasion: "Occasion", holiday: "Public holiday" };
const nice = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

export function BoardClient({ news, party, canManage, nowIso }: { news: News[]; party: Party[]; canManage: boolean; nowIso: string }) {
  const { busy, run, Msg, post } = useAction();
  const [a, setA] = useState({ title: "", body: "", pinned: false, publishAt: "", expiresAt: "" });
  const [o, setO] = useState({ title: "", onDate: "", message: "", yearly: false, kind: "celebration" });
  const toIso = (local: string) => (local ? new Date(`${local}:00+04:00`).toISOString() : undefined);
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="flex flex-col gap-4 lg:col-span-2">
        {canManage && (
          <form className="card grid gap-3 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => post("/api/v1/hr/announcements", { title: a.title, body: a.body, pinned: a.pinned, ...(a.publishAt ? { publishAt: toIso(a.publishAt) } : {}), ...(a.expiresAt ? { expiresAt: toIso(a.expiresAt) } : {}) }), "Posted.", () => setA({ title: "", body: "", pinned: false, publishAt: "", expiresAt: "" })); }}>
            <h2 className="font-semibold sm:col-span-2">Post an announcement</h2>
            <Lbl label="Title" wide><input className="input" required maxLength={200} value={a.title} onChange={(e) => setA({ ...a, title: e.target.value })} /></Lbl>
            <Lbl label="Message" wide><textarea className="input" required rows={4} maxLength={5000} value={a.body} onChange={(e) => setA({ ...a, body: e.target.value })} /></Lbl>
            <Lbl label="Show from (Dubai time, blank = now)"><input className="input" type="datetime-local" value={a.publishAt} onChange={(e) => setA({ ...a, publishAt: e.target.value })} /></Lbl>
            <Lbl label="Hide after (optional)"><input className="input" type="datetime-local" value={a.expiresAt} onChange={(e) => setA({ ...a, expiresAt: e.target.value })} /></Lbl>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={a.pinned} onChange={(e) => setA({ ...a, pinned: e.target.checked })} />Pin to the top</label>
            <div><button className="btn" disabled={busy}>Post</button></div>
          </form>
        )}
        <Msg />
        {news.length === 0 && <p className="muted text-sm">No announcements.</p>}
        {news.map((n) => {
          const scheduled = n.publishAt > nowIso, expired = !!n.expiresAt && n.expiresAt <= nowIso;
          return (
            <article key={n.id} className="card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold">{n.pinned && <span className="badge mr-2">Pinned</span>}{n.title}</h3><span className="muted text-xs">{new Date(n.publishAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric" })}{scheduled && " (scheduled)"}{expired && " (expired)"}</span></div>
              <p className="mt-2 whitespace-pre-wrap text-sm">{n.body}</p>
              {canManage && <button className="btn-ghost err mt-2 text-xs" disabled={busy} onClick={() => confirm("Remove this announcement?") && run(() => post(`/api/v1/hr/announcements/${n.id}`, undefined, "DELETE"), "Removed.")}>Remove</button>}
            </article>
          );
        })}
      </div>
      <div className="flex flex-col gap-4">
        <div className="card p-4">
          <h2 className="mb-2 font-semibold">Celebrations and dates</h2>
          {party.length === 0 ? <p className="muted text-sm">Nothing in the next 60 days.</p> : (
            <ul className="flex flex-col gap-2.5 text-sm">{party.map((c, i) => <li key={i}><div className="flex justify-between gap-2"><b>{c.title}</b><span className="muted whitespace-nowrap text-xs">{c.daysAway === 0 ? "Today" : c.daysAway === 1 ? "Tomorrow" : nice(c.date)}</span></div><span className="muted text-xs">{KIND[c.kind]}{c.detail ? ` - ${c.detail}` : ""}</span></li>)}</ul>
          )}
        </div>
        {canManage && (
          <form className="card flex flex-col gap-3 p-4" onSubmit={(e) => { e.preventDefault(); void run(() => post("/api/v1/hr/occasions", { title: o.title, onDate: o.onDate, kind: o.kind, yearly: o.yearly, ...(o.message.trim() ? { message: o.message.trim() } : {}) }), "Occasion added.", () => setO({ title: "", onDate: "", message: "", yearly: false, kind: "celebration" })); }}>
            <h2 className="font-semibold">Add an occasion</h2>
            <Lbl label="Title"><input className="input" required value={o.title} onChange={(e) => setO({ ...o, title: e.target.value })} placeholder="Company anniversary" /></Lbl>
            <Lbl label="Date"><input className="input" type="date" required value={o.onDate} onChange={(e) => setO({ ...o, onDate: e.target.value })} /></Lbl>
            <Lbl label="Type"><select className="input" value={o.kind} onChange={(e) => setO({ ...o, kind: e.target.value })}><option value="celebration">Celebration</option><option value="event">Event</option><option value="holiday_notice">Holiday notice</option><option value="other">Other</option></select></Lbl>
            <Lbl label="Message (optional)"><input className="input" value={o.message} onChange={(e) => setO({ ...o, message: e.target.value })} /></Lbl>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={o.yearly} onChange={(e) => setO({ ...o, yearly: e.target.checked })} />Repeats every year</label>
            <button className="btn self-start" disabled={busy}>Add</button>
          </form>
        )}
      </div>
    </div>
  );
}
