"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function NoticeActions({ id, read, requiresAck, acked }: { id: string; read: boolean; requiresAck: boolean; acked: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function mark(ack: boolean) { setBusy(true); await postJson(`/api/v1/notices/${id}`, { ack }); setBusy(false); router.refresh(); }
  return (
    <span className="flex gap-2">
      {!read && !requiresAck && <button className="btn-ghost text-xs" disabled={busy} onClick={() => mark(false)}>Mark as read</button>}
      {requiresAck && !acked && <button className="btn text-xs" disabled={busy} onClick={() => mark(true)}>I have read and understood</button>}
      {requiresAck && acked && <span className="badge badge-ok">Acknowledged</span>}
    </span>
  );
}

export function Composer({ branches, companyWide }: { branches: { id: string; name: string }[]; companyWide: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", body: "", audience: companyWide ? "all" : "branch", branchId: branches[0]?.id ?? "", pinned: false, requiresAck: false, publishAt: "", expiresAt: "" });
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const dt = (v: string) => new Date(`${v}:00+04:00`).toISOString();
    const r = await postJson("/api/v1/notices", { title: f.title, body: f.body, audience: f.audience, branchId: f.audience === "branch" ? f.branchId : null, pinned: f.pinned, requiresAck: f.requiresAck, ...(f.publishAt && { publishAt: dt(f.publishAt) }), ...(f.expiresAt && { expiresAt: dt(f.expiresAt) }) });
    if (!r.ok) return setMsg(errMsg(r));
    setOpen(false); setF({ ...f, title: "", body: "", pinned: false, requiresAck: false, publishAt: "", expiresAt: "" }); router.refresh();
  }
  const lab = "flex flex-col gap-1.5 text-sm";
  const cap = "muted text-xs font-medium";
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>+ Post a notice</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Post a notice">
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={save} className="relative flex h-full w-full max-w-xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-xl font-semibold">Post a notice</h2><p className="muted text-sm">Everyone in the audience is notified when it goes live.</p></header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
              <label className={lab}><span className={cap}>Title</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={200} autoFocus /></label>
              <label className={lab}><span className={cap}>Message</span><textarea className="input min-h-40" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required /></label>
              <div className="grid grid-cols-2 gap-4">
                <label className={lab}><span className={cap}>Audience</span><select className="input" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} disabled={!companyWide}>{companyWide && <option value="all">Everyone</option>}<option value="branch">One branch</option></select></label>
                {f.audience === "branch" && <label className={lab}><span className={cap}>Branch</span><select className="input" value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
                <label className={lab}><span className={cap}>Publish at (Dubai, empty = now)</span><input className="input" type="datetime-local" value={f.publishAt} onChange={(e) => setF({ ...f, publishAt: e.target.value })} /></label>
                <label className={lab}><span className={cap}>Expires (optional)</span><input className="input" type="datetime-local" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></label>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to the top</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.requiresAck} onChange={(e) => setF({ ...f, requiresAck: e.target.checked })} /> Everyone must acknowledge (policy, compliance)</label>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p><div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn">Post</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}

export function Receipts({ id }: { id: string }) {
  const [data, setData] = useState<{ total: number; read: number; acked: number; requiresAck: boolean; pending: string[] } | null>(null);
  const router = useRouter();
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex gap-2">
        <button className="btn-ghost text-xs" onClick={async () => { const r = await fetch(`/api/v1/notices/${id}`); if (r.ok) setData(await r.json()); }}>Who has read it</button>
        <button className="btn-ghost text-xs" onClick={async () => { await postJson(`/api/v1/notices/${id}`, undefined, "DELETE"); router.refresh(); }}>Archive</button>
      </span>
      {data && <span className="muted text-right text-xs">{data.read}/{data.total} read{data.requiresAck ? `, ${data.acked} acknowledged` : ""}{data.pending.length > 0 && <><br />Waiting: {data.pending.slice(0, 6).join(", ")}{data.pending.length > 6 ? ` +${data.pending.length - 6}` : ""}</>}</span>}
    </span>
  );
}
