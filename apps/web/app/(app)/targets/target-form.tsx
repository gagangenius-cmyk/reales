"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Opt { id: string; name: string }
const METRICS: [string, string][] = [["closed_value", "Closed deal value (AED)"], ["closed_deals", "Closed deals"], ["new_leads", "New leads"], ["viewings_done", "Viewings completed"]];

export function TargetForm({ period, periodStart, users, teams, branches, canTenant }: { period: string; periodStart: string; users: Opt[]; teams: Opt[]; branches: Opt[]; canTenant: boolean }) {
  const router = useRouter();
  const [scopeType, setScopeType] = useState(users.length ? "user" : teams.length ? "team" : "branch");
  const [scopeId, setScopeId] = useState("");
  const [metric, setMetric] = useState("closed_value");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const list = scopeType === "user" ? users : scopeType === "team" ? teams : scopeType === "branch" ? branches : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const r = await postJson("/api/v1/targets", { scopeType, ...(scopeType !== "tenant" && { scopeId }), periodType: period, periodStart, metric, targetValue: Number(value), ...(note && { note }) }, "PUT");
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMsg({ ok: true, text: "Target saved." }); setValue(""); setNote("");
    router.refresh();
  }
  const lab = "flex flex-col gap-1.5 text-sm";
  const cap = "muted text-xs font-medium";
  return (
    <form onSubmit={submit} className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
      <label className={lab}><span className={cap}>For</span><select className="input" value={scopeType} onChange={(e) => { setScopeType(e.target.value); setScopeId(""); }}>
        {users.length > 0 && <option value="user">A person</option>}{teams.length > 0 && <option value="team">A team</option>}{branches.length > 0 && <option value="branch">A branch</option>}{canTenant && <option value="tenant">Whole company</option>}
      </select></label>
      {scopeType !== "tenant" && <label className={`${lab} lg:col-span-2`}><span className={cap}>Who</span><select className="input" value={scopeId} onChange={(e) => setScopeId(e.target.value)} required><option value="">Choose...</option>{list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}
      <label className={lab}><span className={cap}>Measure</span><select className="input" value={metric} onChange={(e) => setMetric(e.target.value)}>{METRICS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className={lab}><span className={cap}>Target for this {period}</span><input className="input" type="number" min="1" step="any" value={value} onChange={(e) => setValue(e.target.value)} required /></label>
      <label className={lab}><span className={cap}>Note</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-6"><button className="btn">Set target</button>{msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p>}</div>
    </form>
  );
}

export function DeleteTarget({ id }: { id: string }) {
  const router = useRouter();
  return <button className="btn-ghost text-xs" onClick={async () => { await postJson(`/api/v1/targets/${id}`, undefined, "DELETE"); router.refresh(); }}>Remove</button>;
}
