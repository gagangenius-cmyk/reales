"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function CommissionActions({ id, status, paid, canApprove }: { id: string; status: string; paid: boolean; canApprove: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canApprove || status === "void" || paid) return null;
  async function go(path: string, body?: unknown) {
    setBusy(true); setMsg(null);
    const r = await postJson(`/api/v1/commissions/${id}/${path}`, body);
    setBusy(false);
    if (!r.ok) return setMsg(r.status === 403 ? "Confirm your second factor first, then retry." : errMsg(r));
    router.refresh();
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      {status === "calculated" && <button className="btn text-xs" disabled={busy} onClick={() => go("approve")}>Approve</button>}
      {status === "approved" && <button className="btn text-xs" disabled={busy} onClick={() => { const reference = prompt("Payment reference (bank transfer / cheque no.)"); if (reference?.trim()) go("pay", { reference: reference.trim() }); }}>Mark paid</button>}
      {msg && <span role="alert" className="err text-xs">{msg}</span>}
    </span>
  );
}

export function PlanForm() {
  const router = useRouter();
  const [f, setF] = useState({ name: "", dealType: "sale", agentType: "any", ratePct: "2", vatPct: "5", agentPct: "50", companyPct: "50" });
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const splits = [{ role: "agent", pct: Number(f.agentPct) }, { role: "company", pct: Number(f.companyPct) }].filter((s) => s.pct > 0);
    const r = await postJson("/api/v1/commission-plans", { name: f.name, dealType: f.dealType, agentType: f.agentType, ratePct: Number(f.ratePct), vatPct: Number(f.vatPct), splits });
    if (!r.ok) return setMsg(errMsg(r));
    setF({ ...f, name: "" });
    router.refresh();
  }
  const lab = "flex flex-col gap-1.5 text-sm";
  const cap = "muted text-xs font-medium";
  return (
    <form onSubmit={submit} className="card grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
      <label className={`${lab} sm:col-span-2`}><span className={cap}>Plan name</span><input className="input" value={f.name} onChange={set("name")} required placeholder="e.g. External agents - sales" /></label>
      <label className={lab}><span className={cap}>Deal type</span><select className="input" value={f.dealType} onChange={set("dealType")}><option value="sale">Sale</option><option value="lease">Lease</option></select></label>
      <label className={lab}><span className={cap}>Applies to</span><select className="input" value={f.agentType} onChange={set("agentType")}><option value="any">All agents</option><option value="internal">Internal agents</option><option value="external">External agents</option></select></label>
      <label className={lab}><span className={cap}>Commission rate % of deal</span><input className="input" type="number" step="0.01" min="0.01" max="100" value={f.ratePct} onChange={set("ratePct")} /></label>
      <label className={lab}><span className={cap}>VAT % on commission</span><input className="input" type="number" step="0.01" min="0" max="30" value={f.vatPct} onChange={set("vatPct")} /></label>
      <label className={lab}><span className={cap}>Agent share %</span><input className="input" type="number" step="0.01" min="0" value={f.agentPct} onChange={set("agentPct")} /></label>
      <label className={lab}><span className={cap}>Company share %</span><input className="input" type="number" step="0.01" min="0" value={f.companyPct} onChange={set("companyPct")} /></label>
      <div className="flex items-end gap-3 sm:col-span-3 lg:col-span-4"><button className="btn">Add plan</button><p role="alert" className="err text-sm">{msg}</p></div>
    </form>
  );
}
