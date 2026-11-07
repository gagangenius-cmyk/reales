"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const TYPES: [string, string][] = [["photos", "Photos"], ["video", "Video"], ["drone", "Drone"], ["floorplan", "Floor plan"], ["virtual_tour", "Virtual tour"]];
const lab = "flex flex-col gap-1.5 text-sm";
const cap = "muted text-xs font-medium";

export function RequestForm({ listings }: { listings: { id: string; title: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ listingId: "", types: ["photos"] as string[], preferredDate: "", contact: "", phone: "", access: "", notes: "" });
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const r = await postJson("/api/v1/photoshoots", { listingId: f.listingId, shootTypes: f.types, preferredDate: f.preferredDate || null, accessContactName: f.contact || null, accessContactPhone: f.phone || null, accessNotes: f.access || null, notes: f.notes || null });
    if (!r.ok) return setMsg(errMsg(r));
    setOpen(false); setF({ ...f, listingId: "", notes: "" }); router.refresh();
  }
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>+ Request a photoshoot</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Request a photoshoot">
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={save} className="relative flex h-full w-full max-w-xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-xl font-semibold">Request a photoshoot</h2></header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
              <label className={lab}><span className={cap}>Listing</span><select className="input" value={f.listingId} onChange={(e) => setF({ ...f, listingId: e.target.value })} required><option value="">Choose a listing</option>{listings.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}</select></label>
              <fieldset className="flex flex-wrap gap-4"><legend className={cap}>What should be shot</legend>
                {TYPES.map(([k, l]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.types.includes(k)} onChange={(e) => setF({ ...f, types: e.target.checked ? [...f.types, k] : f.types.filter((x) => x !== k) })} />{l}</label>)}</fieldset>
              <label className={lab}><span className={cap}>Preferred date (optional)</span><input className="input" type="date" value={f.preferredDate} onChange={(e) => setF({ ...f, preferredDate: e.target.value })} /></label>
              <div className="grid grid-cols-2 gap-4">
                <label className={lab}><span className={cap}>Contact on site</span><input className="input" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} maxLength={120} /></label>
                <label className={lab}><span className={cap}>Phone</span><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={40} /></label>
              </div>
              <label className={lab}><span className={cap}>Access (keys, parking, building rules)</span><input className="input" value={f.access} onChange={(e) => setF({ ...f, access: e.target.value })} maxLength={500} /></label>
              <label className={lab}><span className={cap}>Notes for the photographer</span><textarea className="input min-h-24" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={1000} /></label>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p><div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={!f.listingId || !f.types.length}>Send request</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}

type Row = { id: string; status: string; mine: boolean; assigned: boolean };

export function ShootActions({ row, manage, people }: { row: Row; manage: boolean; people: { id: string; email: string }[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<null | "schedule" | "deliver" | "cancel">(null);
  const [f, setF] = useState({ at: "", minutes: 120, photographerUserId: "", photographerName: "", count: 20, note: "", reason: "" });
  const [msg, setMsg] = useState<string | null>(null);
  async function act(body: object) {
    setMsg(null);
    const r = await postJson(`/api/v1/photoshoots/${row.id}`, body);
    if (!r.ok) return setMsg(errMsg(r));
    setMode(null); router.refresh();
  }
  const open = ["requested", "scheduled", "in_progress"].includes(row.status);
  const operate = manage || row.assigned;
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {manage && ["requested", "scheduled"].includes(row.status) && <button className="btn-ghost text-xs" onClick={() => setMode("schedule")}>{row.status === "requested" ? "Schedule" : "Reschedule"}</button>}
        {operate && row.status === "scheduled" && <button className="btn-ghost text-xs" onClick={() => act({ action: "start" })}>Start</button>}
        {operate && row.status === "in_progress" && <button className="btn-ghost text-xs" onClick={() => setMode("deliver")}>Deliver</button>}
        {open && (manage || (row.mine && row.status !== "in_progress")) && <button className="btn-ghost text-xs" onClick={() => setMode("cancel")}>Cancel</button>}
      </div>
      {mode === "schedule" && (
        <form className="card flex w-72 flex-col gap-2 p-3" onSubmit={(e) => { e.preventDefault(); void act({ action: "schedule", scheduledAt: new Date(`${f.at}:00+04:00`).toISOString(), durationMinutes: f.minutes, photographerUserId: f.photographerUserId || null, photographerName: f.photographerName || null }); }}>
          <label className={lab}><span className={cap}>Date and time (Dubai)</span><input className="input" type="datetime-local" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} required /></label>
          <label className={lab}><span className={cap}>Minutes</span><input className="input" type="number" min={15} max={480} value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })} /></label>
          {people.length > 0 && <label className={lab}><span className={cap}>Photographer (staff)</span><select className="input" value={f.photographerUserId} onChange={(e) => setF({ ...f, photographerUserId: e.target.value })}><option value="">External / name below</option>{people.map((p) => <option key={p.id} value={p.id}>{p.email}</option>)}</select></label>}
          {!f.photographerUserId && <label className={lab}><span className={cap}>Photographer name</span><input className="input" value={f.photographerName} onChange={(e) => setF({ ...f, photographerName: e.target.value })} maxLength={120} /></label>}
          <div className="flex gap-2"><button className="btn text-xs">Save</button><button type="button" className="btn-ghost text-xs" onClick={() => setMode(null)}>Close</button></div>
        </form>)}
      {mode === "deliver" && (
        <form className="card flex w-72 flex-col gap-2 p-3" onSubmit={(e) => { e.preventDefault(); void act({ action: "deliver", mediaCount: f.count, note: f.note || null }); }}>
          <p className="muted text-xs">Upload the files to the listing first, then record the hand-over here.</p>
          <label className={lab}><span className={cap}>Files delivered</span><input className="input" type="number" min={1} max={500} value={f.count} onChange={(e) => setF({ ...f, count: Number(e.target.value) })} /></label>
          <label className={lab}><span className={cap}>Note</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={500} /></label>
          <div className="flex gap-2"><button className="btn text-xs">Mark delivered</button><button type="button" className="btn-ghost text-xs" onClick={() => setMode(null)}>Close</button></div>
        </form>)}
      {mode === "cancel" && (
        <form className="card flex w-72 flex-col gap-2 p-3" onSubmit={(e) => { e.preventDefault(); void act({ action: "cancel", reason: f.reason }); }}>
          <label className={lab}><span className={cap}>Reason</span><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={255} required /></label>
          <div className="flex gap-2"><button className="btn text-xs">Cancel the shoot</button><button type="button" className="btn-ghost text-xs" onClick={() => setMode(null)}>Close</button></div>
        </form>)}
      {msg && <p role="alert" className="err max-w-72 text-xs">{msg}</p>}
    </div>
  );
}
