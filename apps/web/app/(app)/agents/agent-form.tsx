"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Row = { userId: string; email: string; profile: any | null };
type Plan = { id: string; name: string; agentType: string; dealType: string };

export function AgentEditor({ row, plans, canManage }: { row: Row; plans: Plan[]; canManage: boolean }) {
  const router = useRouter();
  const p = row.profile;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ agentType: p?.agentType ?? "internal", brn: p?.brn ?? "", agencyName: p?.agencyName ?? "", agencyLicenceNo: p?.agencyLicenceNo ?? "", commissionPlanId: p?.commissionPlanId ?? "", payoutNote: p?.payoutNote ?? "", status: p?.status ?? "active" });
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  if (!canManage) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const r = await postJson("/api/v1/agent-profiles", { userId: row.userId, ...f, commissionPlanId: f.commissionPlanId || null, brn: f.brn || null, agencyName: f.agentType === "external" ? f.agencyName || null : null, agencyLicenceNo: f.agencyLicenceNo || null, payoutNote: f.payoutNote || null }, "PUT");
    if (!r.ok) return setMsg(errMsg(r));
    setOpen(false);
    router.refresh();
  }
  const usable = plans.filter((x) => x.agentType === "any" || x.agentType === f.agentType);
  return (
    <>
      <button className="btn-ghost text-xs" onClick={() => setOpen(true)}>{p ? "Edit" : "Set up"}</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Agent profile ${row.email}`}>
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={save} className="relative flex h-full w-full max-w-xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-lg font-semibold">Agent profile</h2><p className="muted text-sm">{row.email}</p></header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Agent type">
                {(["internal", "external"] as const).map((t) => (
                  <button key={t} type="button" role="radio" aria-checked={f.agentType === t} onClick={() => setF({ ...f, agentType: t, commissionPlanId: "" })} className="card p-3 text-left" style={{ borderColor: f.agentType === t ? "var(--accent)" : undefined, boxShadow: f.agentType === t ? "0 0 0 2px var(--accent)" : undefined }}>
                    <span className="font-semibold capitalize">{t} agent</span><br /><span className="muted text-xs">{t === "internal" ? "Staff of your brokerage." : "Freelancer or partner brokerage (co-broke), paid per deal."}</span>
                  </button>
                ))}
              </div>
              <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">RERA broker card (BRN)</span><input className="input" value={f.brn} onChange={set("brn")} /></label>
              {f.agentType === "external" && (
                <>
                  <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Agency name (or &quot;Freelance&quot;)</span><input className="input" value={f.agencyName} onChange={set("agencyName")} required /></label>
                  <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Agency trade licence no.</span><input className="input" value={f.agencyLicenceNo} onChange={set("agencyLicenceNo")} /></label>
                </>
              )}
              <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Commission plan</span>
                <select className="input" value={f.commissionPlanId} onChange={set("commissionPlanId")}><option value="">Automatic (newest plan for {f.agentType} agents)</option>{usable.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.dealType})</option>)}</select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Payout note (e.g. bank, invoice requirement)</span><input className="input" value={f.payoutNote} onChange={set("payoutNote")} /></label>
              <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Status</span><select className="input" value={f.status} onChange={set("status")}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p>
              <div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn">Save profile</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}
