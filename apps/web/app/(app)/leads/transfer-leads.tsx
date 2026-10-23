"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

/** Move one person's leads to another (a leaver, someone on leave). Shows how many will move before anything changes. */
export function TransferLeads({ users }: { users: { id: string; email: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ fromUserId: "", toUserId: "", scope: "open", reason: "" });
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const body = (dryRun: boolean) => ({ ...v, ...(v.reason.trim() ? { reason: v.reason.trim() } : {}), dryRun });
  async function preview() {
    setBusy(true); setMsg(null); setCount(null);
    const r = await postJson("/api/v1/leads/transfer", body(true));
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setCount(r.data.count);
  }
  async function run() {
    setBusy(true); setMsg(null);
    const r = await postJson("/api/v1/leads/transfer", body(false));
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMsg({ ok: r.data.failed.length === 0, text: `${r.data.done} of ${r.data.count} leads transferred${r.data.failed.length ? `, ${r.data.failed.length} could not move (${[...new Set(r.data.failed.map((f: { reason: string }) => f.reason))].slice(0, 2).join("; ")})` : ""}.` });
    setCount(null); router.refresh();
  }
  if (!open) return <button className="btn-ghost" onClick={() => setOpen(true)}>Transfer leads</button>;
  return (
    <form className="card grid gap-3 p-4 text-sm sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void (count === null ? preview() : run()); }}>
      <h2 className="font-semibold sm:col-span-4">Transfer leads between people</h2>
      <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">From</span><select className="input" required value={v.fromUserId} onChange={(e) => { setV({ ...v, fromUserId: e.target.value }); setCount(null); }}><option value="">Choose...</option>{users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}</select></label>
      <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">To</span><select className="input" required value={v.toUserId} onChange={(e) => { setV({ ...v, toUserId: e.target.value }); setCount(null); }}><option value="">Choose...</option>{users.filter((u) => u.id !== v.fromUserId).map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}</select></label>
      <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Which leads</span><select className="input" value={v.scope} onChange={(e) => { setV({ ...v, scope: e.target.value }); setCount(null); }}><option value="open">Open leads</option><option value="hot">Hot open leads</option><option value="all">All leads, including won and lost</option></select></label>
      <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Reason</span><input className="input" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="Agent left the company" /></label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-4">
        <button className="btn" disabled={busy || !v.fromUserId || !v.toUserId}>{busy ? "Working..." : count === null ? "Check how many will move" : `Transfer ${count} lead${count === 1 ? "" : "s"}`}</button>
        <button type="button" className="btn-ghost" onClick={() => { setOpen(false); setCount(null); setMsg(null); }}>Close</button>
        {count === 0 && <span className="muted">Nothing to transfer.</span>}{msg && <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "muted" : "err"}>{msg.text}</span>}
      </div>
    </form>
  );
}
