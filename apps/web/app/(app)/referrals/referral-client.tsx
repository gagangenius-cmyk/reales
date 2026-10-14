"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function PartnerForm() {
  const router = useRouter();
  const [f, setF] = useState({ name: "", kind: "broker", feePct: "20" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await postJson("/api/v1/referral-partners", { name: f.name, kind: f.kind, feePct: Number(f.feePct) });
    if (!r.ok) return setError(errMsg(r));
    setF({ ...f, name: "" });
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-3 p-4">
      <label className="grow text-sm">New partner<input className="input mt-1 w-full" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={160} /></label>
      <label className="text-sm">Type<select className="input mt-1" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["broker", "developer", "bank", "corporate", "individual"].map((k) => <option key={k}>{k}</option>)}</select></label>
      <label className="text-sm">Fee % of our commission<input className="input mt-1 w-24" inputMode="decimal" value={f.feePct} onChange={(e) => setF({ ...f, feePct: e.target.value })} required /></label>
      <button className="btn">Add partner</button>
      {error && <p role="alert" className="err w-full text-sm">{error}</p>}
    </form>
  );
}

export function ReferralForm({ partners, leads }: { partners: Array<{ id: string; label: string }>; leads: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const [partnerId, setPartnerId] = useState(partners[0]?.id ?? "");
  const [leadId, setLeadId] = useState(leads[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await postJson("/api/v1/referrals", { partnerId, leadId });
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-3 p-4">
      <label className="text-sm">Partner<select className="input mt-1" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>{partners.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <label className="text-sm">Lead<select className="input mt-1" value={leadId} onChange={(e) => setLeadId(e.target.value)}>{leads.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></label>
      <button className="btn" disabled={!partnerId || !leadId}>Attribute lead to partner</button>
      {error && <p role="alert" className="err w-full text-sm">{error}</p>}
    </form>
  );
}

export function ReferralActions({ id, status, canManage, canSettle }: { id: string; status: string; canManage: boolean; canSettle: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function run(path: string, body?: unknown) {
    setError(null);
    const r = await postJson(`/api/v1/referrals/${id}/${path}`, body);
    if (!r.ok) return setError(r.data?.error?.code === "step_up_required" ? "Re-verify your second factor first (step-up)." : errMsg(r));
    router.refresh();
  }
  return (
    <span className="flex flex-wrap gap-2">
      {canSettle && status === "submitted" && <button className="btn-ghost text-xs" onClick={() => run("settle")}>Settle</button>}
      {canSettle && status === "won" && <button className="btn-ghost text-xs" onClick={() => run("pay")}>Mark paid</button>}
      {canManage && (status === "submitted" || status === "won") && <button className="btn-ghost text-xs" onClick={() => { const reason = window.prompt("Reason for voiding?"); if (reason) run("void", { reason }); }}>Void</button>}
      {error && <span role="alert" className="err text-xs">{error}</span>}
    </span>
  );
}
