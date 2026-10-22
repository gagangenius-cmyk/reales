"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function ClaimButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button className="btn text-xs" disabled={busy} onClick={async () => { setBusy(true); setMsg(null); const r = await postJson(`/api/v1/leads/${leadId}/claim`); setBusy(false); if (!r.ok) { setMsg(errMsg(r)); router.refresh(); return; } router.push(`/leads/${leadId}`); }}>{busy ? "Claiming..." : "Claim"}</button>
      {msg && <span role="alert" className="err max-w-56 text-right text-xs">{msg}</span>}
    </span>
  );
}

export function PoolForm({ pool, branches }: { pool?: { id: string; name: string; description: string | null; dailyClaimLimit: number | null; active: boolean; branchId: string | null }; branches: { id: string; name: string }[] }) {
  const router = useRouter();
  const [f, setF] = useState({ name: pool?.name ?? "", description: pool?.description ?? "", limit: pool?.dailyClaimLimit ? String(pool.dailyClaimLimit) : "", branchId: pool?.branchId ?? "", active: pool?.active ?? true });
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const r = await postJson("/api/v1/pools", { ...(pool && { id: pool.id }), name: f.name, description: f.description || null, dailyClaimLimit: f.limit ? Number(f.limit) : null, branchId: f.branchId || null, active: f.active });
    if (!r.ok) return setMsg(errMsg(r));
    if (!pool) setF({ ...f, name: "", description: "", limit: "" });
    router.refresh();
  }
  return (
    <form onSubmit={save} className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
      <label className="flex flex-col gap-1.5 text-sm lg:col-span-2"><span className="muted text-xs font-medium">{pool ? "Pool name" : "New pool"}</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="e.g. Portal enquiries" /></label>
      <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Claims per agent per day</span><input className="input" type="number" min="1" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} placeholder="No limit" /></label>
      <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Branch</span><select className="input" value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">Any</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <div className="flex items-end gap-3"><button className="btn">{pool ? "Save" : "Create pool"}</button>{pool && <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>}</div>
      {msg && <p role="alert" className="err text-sm sm:col-span-2 lg:col-span-5">{msg}</p>}
    </form>
  );
}

export function RuleForm({ pools }: { pools: { id: string; name: string }[] }) {
  const router = useRouter();
  const [f, setF] = useState({ name: "", triggerKind: "no_first_response", afterMinutes: "30", action: "to_pool", poolId: pools[0]?.id ?? "", maxRepools: "3", hotOnly: false });
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const r = await postJson("/api/v1/repool-rules", { name: f.name, triggerKind: f.triggerKind, afterMinutes: Number(f.afterMinutes), action: f.action, poolId: f.action === "notify_manager" ? null : f.poolId || null, maxRepools: Number(f.maxRepools), hotOnly: f.hotOnly });
    if (!r.ok) return setMsg(errMsg(r));
    setF({ ...f, name: "" }); router.refresh();
  }
  const lab = "flex flex-col gap-1.5 text-sm";
  const cap = "muted text-xs font-medium";
  return (
    <form onSubmit={save} className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <label className={`${lab} lg:col-span-2`}><span className={cap}>Rule name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="e.g. Hot leads: 15 minutes to respond" /></label>
      <label className={lab}><span className={cap}>When the agent has not...</span><select className="input" value={f.triggerKind} onChange={(e) => setF({ ...f, triggerKind: e.target.value })}><option value="no_first_response">Responded at all</option><option value="no_activity">Done anything on the lead</option></select></label>
      <label className={lab}><span className={cap}>...for (minutes)</span><input className="input" type="number" min="5" value={f.afterMinutes} onChange={(e) => setF({ ...f, afterMinutes: e.target.value })} /></label>
      <label className={lab}><span className={cap}>Then</span><select className="input" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}><option value="to_pool">Put it back in a pool</option><option value="reassign">Give it to the next agent</option><option value="notify_manager">Only alert managers</option></select></label>
      {f.action !== "notify_manager" && <label className={lab}><span className={cap}>{f.action === "reassign" ? "Fallback pool" : "Pool"}</span><select className="input" value={f.poolId} onChange={(e) => setF({ ...f, poolId: e.target.value })} required={f.action === "to_pool"}><option value="">None</option>{pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      <label className={lab}><span className={cap}>Stop after this many repools</span><input className="input" type="number" min="1" max="20" value={f.maxRepools} onChange={(e) => setF({ ...f, maxRepools: e.target.value })} /></label>
      <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={f.hotOnly} onChange={(e) => setF({ ...f, hotOnly: e.target.checked })} /> Hot leads only</label>
      <div className="flex items-end gap-3"><button className="btn">Add rule</button></div>
      {msg && <p role="alert" className="err text-sm sm:col-span-2 lg:col-span-4">{msg}</p>}
    </form>
  );
}

export function RuleActions({ id, active, rule }: { id: string; active: boolean; rule: Record<string, unknown> }) {
  const router = useRouter();
  return (
    <span className="flex gap-2">
      <button className="btn-ghost text-xs" onClick={async () => { await postJson("/api/v1/repool-rules", { ...rule, id, active: !active }); router.refresh(); }}>{active ? "Pause" : "Resume"}</button>
      <button className="btn-ghost text-xs" onClick={async () => { await postJson(`/api/v1/repool-rules/${id}`, undefined, "DELETE"); router.refresh(); }}>Delete</button>
    </span>
  );
}

export function ReleaseButton({ leadId, pools }: { leadId: string; pools: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [poolId, setPoolId] = useState(pools[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  if (pools.length === 0) return null;
  return (
    <>
      <button className="btn-ghost" onClick={() => setOpen(true)}>Release to pool</button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Release to pool">
          <form className="card w-full max-w-md p-5" onSubmit={async (e) => { e.preventDefault(); setMsg(null); const r = await postJson(`/api/v1/leads/${leadId}/release`, { poolId, reason }); if (!r.ok) return setMsg(errMsg(r)); setOpen(false); router.refresh(); }}>
            <h2 className="font-semibold">Release this lead</h2><p className="muted mb-3 text-sm">It becomes unassigned and any permitted agent can claim it.</p>
            <select className="input mb-3" value={poolId} onChange={(e) => setPoolId(e.target.value)}>{pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            {msg && <p role="alert" className="err mt-2 text-sm">{msg}</p>}
            <div className="mt-3 flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={!reason.trim()}>Release</button></div>
          </form>
        </div>
      )}
    </>
  );
}
