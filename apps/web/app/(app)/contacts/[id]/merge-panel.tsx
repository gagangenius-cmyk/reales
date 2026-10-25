"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Dup = { id: string; name: string; email: string | null; phone: string | null };

/** Possible duplicates of this contact, with a two-step merge into it. The other contact is archived (restorable from Trash), never destroyed. */
export function MergePanel({ contactId, duplicates }: { contactId: string; duplicates: Dup[] }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!duplicates.length) return null;
  async function merge(id: string) {
    setBusy(true); setMsg(null);
    const r = await postJson(`/api/v1/contacts/${contactId}/merge`, { duplicateId: id });
    setBusy(false);
    if (r.ok) { setMsg(`Merged. Moved: ${Object.entries(r.data.moved ?? {}).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ") || "nothing to move"}.`); setConfirm(null); router.refresh(); } else setMsg(errMsg(r));
  }
  return (
    <div className="card p-4">
      <h2 className="mb-1 font-semibold">Possible duplicates</h2>
      <p className="muted mb-3 text-xs">Same email or phone. Merging moves their leads, calls, deals and history here and archives the other contact. Consent is not copied across.</p>
      <ul className="flex flex-col gap-2 text-sm">
        {duplicates.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
            <span><b>{d.name}</b> <span className="muted text-xs">{[d.email, d.phone].filter(Boolean).join(" / ")}</span></span>
            {confirm === d.id
              ? <span className="inline-flex gap-2"><button className="btn" disabled={busy} onClick={() => merge(d.id)}>{busy ? "Merging..." : "Confirm merge"}</button><button className="btn-ghost" onClick={() => setConfirm(null)}>Cancel</button></span>
              : <button className="btn-ghost" onClick={() => setConfirm(d.id)}>Merge into this contact</button>}
          </li>
        ))}
      </ul>
      {msg && <p role="status" className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
