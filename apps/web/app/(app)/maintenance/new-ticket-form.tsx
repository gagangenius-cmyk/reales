"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const CATEGORIES = ["plumbing", "electrical", "hvac", "appliance", "structural", "cleaning", "pest", "other"];

export function NewTicketForm({ units }: { units: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const [f, setF] = useState({ unitId: units[0]?.id ?? "", category: "plumbing", priority: "normal", title: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson("/api/v1/maintenance-tickets", f);
    setBusy(false);
    if (!r.ok) return setError(errMsg(r));
    setF({ ...f, title: "" });
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-3 p-4">
      <label className="text-sm">Unit<select className="input mt-1" value={f.unitId} onChange={(e) => setF({ ...f, unitId: e.target.value })} required>{units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</select></label>
      <label className="text-sm">Category<select className="input mt-1" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label className="text-sm">Priority<select className="input mt-1" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{["urgent", "high", "normal", "low"].map((c) => <option key={c}>{c}</option>)}</select></label>
      <label className="grow text-sm">Issue<input className="input mt-1 w-full" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={255} /></label>
      <button className="btn" disabled={busy || !f.unitId}>{busy ? "Saving..." : "Log ticket"}</button>
      {error && <p role="alert" className="err w-full text-sm">{error}</p>}
    </form>
  );
}
