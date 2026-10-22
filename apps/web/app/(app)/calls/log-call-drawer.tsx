"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const OUTCOMES: [string, string][] = [["answered", "Answered"], ["no_answer", "No answer"], ["busy", "Busy"], ["voicemail", "Voicemail"], ["wrong_number", "Wrong number"], ["callback_requested", "Callback requested"], ["not_interested", "Not interested"]];
type Contact = { id: string; firstName?: string | null; lastName?: string | null; companyName?: string | null; phoneE164?: string | null; email?: string | null };
const name = (c: Contact) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.phoneE164 || "Contact";

/** Log a call for a known lead/contact, or search for the contact first. Duration is entered as minutes and seconds. */
export function LogCallDrawer({ leadId, contactId, contactLabel, label = "Log a call" }: { leadId?: string; contactId?: string; contactLabel?: string; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ direction: "outbound", outcome: "answered", min: "", sec: "", notes: "", followUp: "" });
  const [picked, setPicked] = useState<Contact | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Contact[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const known = !!(leadId || contactId);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false); document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [open]);
  useEffect(() => {
    if (known || q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(async () => { try { const r = await fetch(`/api/v1/contacts?q=${encodeURIComponent(q.trim())}&limit=6&offset=0`); const j = await r.json(); setFound(r.ok ? j.contacts ?? [] : []); } catch { setFound([]); } }, 250);
    return () => clearTimeout(t);
  }, [q, known]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const cid = contactId ?? picked?.id;
    if (!leadId && !cid) return setMsg("Choose who you called.");
    const durationSec = (Number(f.min || 0) * 60) + Number(f.sec || 0);
    setBusy(true);
    const r = await postJson("/api/v1/calls", { ...(leadId ? { leadId } : { contactId: cid }), direction: f.direction, outcome: f.outcome, durationSec, ...(f.notes.trim() && { notes: f.notes.trim() }), ...(f.followUp && { followUpAt: new Date(`${f.followUp}:00+04:00`).toISOString() }) });
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r));
    setOpen(false); setF({ direction: "outbound", outcome: "answered", min: "", sec: "", notes: "", followUp: "" }); setPicked(null); setQ("");
    router.refresh();
  }
  const lab = "flex flex-col gap-1.5 text-sm";
  const cap = "muted text-xs font-medium";
  return (
    <>
      <button className="btn" onClick={() => { setOpen(true); setMsg(null); }}>{label}</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Log a call">
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={submit} className="relative flex h-full w-full max-w-lg flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-xl font-semibold">Log a call</h2><p className="muted text-sm">Updates the lead timeline, last contacted, and the follow-up.</p></header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
              <section className="card flex flex-col gap-3 p-4">
                <h3 className="font-semibold">Who</h3>
                {known ? <p className="text-sm">{contactLabel ?? "This contact"}</p> : picked ? (
                  <div className="flex items-center justify-between text-sm"><span>{name(picked)}<br /><span className="muted text-xs">{picked.phoneE164}</span></span><button type="button" className="btn-ghost text-xs" onClick={() => setPicked(null)}>Change</button></div>
                ) : (
                  <>
                    <input className="input" placeholder="Search name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
                    <ul className="flex flex-col gap-1 text-sm">{found.map((c) => <li key={c.id}><button type="button" className="w-full rounded-lg border p-2 text-left hover:opacity-80" style={{ borderColor: "var(--border)" }} onClick={() => setPicked(c)}>{name(c)} <span className="muted text-xs">{c.phoneE164 ?? c.email ?? ""}</span></button></li>)}</ul>
                  </>
                )}
              </section>
              <section className="card grid grid-cols-2 gap-4 p-4">
                <label className={lab}><span className={cap}>Direction</span><select className="input" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="outbound">I called them</option><option value="inbound">They called me</option></select></label>
                <label className={lab}><span className={cap}>Outcome</span><select className="input" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                <label className={lab}><span className={cap}>Minutes</span><input className="input" type="number" min="0" max="360" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></label>
                <label className={lab}><span className={cap}>Seconds</span><input className="input" type="number" min="0" max="59" value={f.sec} onChange={(e) => setF({ ...f, sec: e.target.value })} /></label>
                <label className={`${lab} col-span-2`}><span className={cap}>Notes</span><textarea className="input min-h-24" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={4000} /></label>
                <label className={`${lab} col-span-2`}><span className={cap}>Next follow-up (Dubai time){f.outcome === "callback_requested" ? ", defaults to tomorrow 10:00" : ""}</span><input className="input" type="datetime-local" value={f.followUp} onChange={(e) => setF({ ...f, followUp: e.target.value })} /></label>
              </section>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p>
              <div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving..." : "Save call"}</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}
