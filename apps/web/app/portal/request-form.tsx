"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const CATEGORIES = ["plumbing", "electrical", "hvac", "appliance", "structural", "cleaning", "pest", "other"];

export function RequestForm({ leases }: { leases: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const [f, setF] = useState({ leaseId: leases[0]?.id ?? "", category: "plumbing", title: "", description: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (leases.length === 0) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const r = await postJson("/api/v1/portal/tenant/requests", f);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMsg({ ok: true, text: "Request sent. Our team will be in touch." });
    setF({ ...f, title: "", description: "" });
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-4">
      <h2 className="font-semibold">Report a maintenance problem</h2>
      <div className="flex flex-wrap gap-3">
        {leases.length > 1 && <label className="text-sm">Home<select className="input mt-1" value={f.leaseId} onChange={(e) => setF({ ...f, leaseId: e.target.value })}>{leases.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></label>}
        <label className="text-sm">Type<select className="input mt-1" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="grow text-sm">What is wrong?<input className="input mt-1 w-full" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} maxLength={255} /></label>
      </div>
      <label className="text-sm">Details (optional)<textarea className="input mt-1 w-full" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={4000} /></label>
      <button className="btn self-start">Send request</button>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "" : "err"}`}>{msg.text}</p>}
    </form>
  );
}
