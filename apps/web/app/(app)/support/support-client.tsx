"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const CATEGORIES: [string, string][] = [["question", "Question"], ["bug", "Something is broken"], ["access", "Access or permissions"], ["data", "Data correction"], ["request", "Feature request"], ["other", "Other"]];

export function NewTicket() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ subject: "", body: "", category: "question", priority: "normal" });
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const r = await postJson("/api/v1/support-tickets", { ...f, pageUrl: window.location.pathname });
    if (!r.ok) return setMsg(errMsg(r));
    setOpen(false); setF({ subject: "", body: "", category: "question", priority: "normal" });
    router.push(`/support/${r.data.id}`);
  }
  const lab = "flex flex-col gap-1.5 text-sm";
  const cap = "muted text-xs font-medium";
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>+ New ticket</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="New ticket">
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={save} className="relative flex h-full w-full max-w-xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-xl font-semibold">New support ticket</h2><p className="muted text-sm">Tell the support team what you need. Urgent tickets get a faster first response.</p></header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
              <label className={lab}><span className={cap}>Subject</span><input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required maxLength={200} autoFocus /></label>
              <div className="grid grid-cols-2 gap-4">
                <label className={lab}><span className={cap}>Type</span><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                <label className={lab}><span className={cap}>Priority</span><select className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High: blocks my work</option><option value="urgent">Urgent: many people blocked</option></select></label>
              </div>
              <label className={lab}><span className={cap}>What happened?</span><textarea className="input min-h-40" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required placeholder="What you were doing, what you expected, what you saw instead." /></label>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p><div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn">Submit</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}

export function TicketThread({ id, status, desk, mine, staff, assigneeId, priority }: { id: string; status: string; desk: boolean; mine: boolean; staff: { id: string; email: string }[]; assigneeId: string | null; priority: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function run(p: Promise<{ ok: boolean; data: any; status: number }>, clear = false) { setMsg(null); const r = await p; if (!r.ok) return setMsg(errMsg(r as any)); if (clear) { setBody(""); setInternal(false); } router.refresh(); }
  return (
    <div className="flex flex-col gap-3">
      {desk && (
        <div className="card flex flex-wrap items-center gap-3 p-3 text-sm">
          <label className="flex items-center gap-2">Status<select className="input w-auto py-1" value={status} onChange={(e) => run(postJson(`/api/v1/support-tickets/${id}`, { status: e.target.value }, "PATCH"))}>{["open", "in_progress", "waiting", "resolved", "closed"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></label>
          <label className="flex items-center gap-2">Priority<select className="input w-auto py-1" value={priority} onChange={(e) => run(postJson(`/api/v1/support-tickets/${id}`, { priority: e.target.value }, "PATCH"))}>{["low", "normal", "high", "urgent"].map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="flex items-center gap-2">Assigned to<select className="input w-auto py-1" value={assigneeId ?? ""} onChange={(e) => run(postJson(`/api/v1/support-tickets/${id}`, { assigneeId: e.target.value || null }, "PATCH"))}><option value="">Nobody</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}</select></label>
        </div>
      )}
      {status !== "closed" ? (
        <form className="card flex flex-col gap-2 p-3" onSubmit={(e) => { e.preventDefault(); void run(postJson(`/api/v1/support-tickets/${id}`, { body, internal }), true); }}>
          <textarea className="input min-h-24" placeholder={desk ? "Reply to the requester, or tick internal note" : "Add a reply"} value={body} onChange={(e) => setBody(e.target.value)} required />
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-4 text-sm">{desk && <label className="flex items-center gap-2"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (not shown to the requester)</label>}</span>
            <span className="flex gap-2">{mine && <button type="button" className="btn-ghost" onClick={() => run(postJson(`/api/v1/support-tickets/${id}`, undefined, "DELETE"))}>Close ticket</button>}<button className="btn" disabled={!body.trim()}>{internal ? "Add note" : "Send reply"}</button></span>
          </div>
        </form>
      ) : <p className="muted text-sm">This ticket is closed.</p>}
      {msg && <p role="alert" className="err text-sm">{msg}</p>}
    </div>
  );
}
