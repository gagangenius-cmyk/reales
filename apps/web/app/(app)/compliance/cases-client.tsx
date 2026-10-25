"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const KINDS: [string, string][] = [["screening_hit", "Screening hit"], ["high_risk", "High risk"], ["suspicious_activity", "Suspicious activity"], ["document_issue", "Document issue"], ["other", "Other"]];

/** Open a compliance case against a KYC profile. */
export function CaseCreate({ profiles }: { profiles: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const [f, setF] = useState({ profileId: "", kind: "other", summary: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(null); setBusy(true);
    const r = await postJson("/api/v1/compliance-cases", { profileId: f.profileId, kind: f.kind, summary: f.summary.trim() });
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r));
    setF({ profileId: "", kind: "other", summary: "" }); setMsg("Case opened."); router.refresh();
  }
  if (!profiles.length) return null;
  return (
    <form onSubmit={submit} className="card grid gap-3 p-4 sm:grid-cols-4">
      <h2 className="font-semibold sm:col-span-4">Open a case</h2>
      <label className="text-sm"><span className="muted text-xs font-medium">KYC profile</span><select className="input mt-1" value={f.profileId} onChange={(e) => setF({ ...f, profileId: e.target.value })} required><option value="">Choose</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <label className="text-sm"><span className="muted text-xs font-medium">Kind</span><select className="input mt-1" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className="text-sm sm:col-span-2"><span className="muted text-xs font-medium">Summary</span><input className="input mt-1" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} required minLength={3} maxLength={1000} /></label>
      <div className="flex items-center gap-3 sm:col-span-4"><button className="btn" disabled={busy}>{busy ? "Opening..." : "Open case"}</button>{msg && <span role="status" className="text-sm">{msg}</span>}</div>
    </form>
  );
}

/** Add a note to a case, or close it with an outcome and a written resolution (at least 10 characters). */
export function CaseActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"note" | "close" | null>(null);
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<"cleared" | "reported" | "rejected">("cleared");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const r = mode === "note" ? await postJson(`/api/v1/compliance-cases/${id}/notes`, { note: text.trim() }) : await postJson(`/api/v1/compliance-cases/${id}/close`, { outcome, resolution: text.trim() });
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r));
    setMode(null); setText(""); router.refresh();
  }
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <button className="btn-ghost text-xs" onClick={() => { setMode(mode === "note" ? null : "note"); setMsg(null); }}>Note</button>
        {status !== "closed" && <button className="btn-ghost text-xs" onClick={() => { setMode(mode === "close" ? null : "close"); setMsg(null); }}>Close</button>}
      </div>
      {mode && (
        <form onSubmit={go} className="flex w-72 flex-col gap-2 text-left">
          {mode === "close" && <select className="input" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} aria-label="Outcome"><option value="cleared">Cleared</option><option value="reported">Reported</option><option value="rejected">Rejected</option></select>}
          <textarea className="input" rows={3} required minLength={mode === "close" ? 10 : 1} maxLength={mode === "close" ? 1000 : 2000} placeholder={mode === "close" ? "Resolution (at least 10 characters)" : "Note"} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn" disabled={busy}>{busy ? "Saving..." : mode === "close" ? "Close case" : "Add note"}</button>
          {msg && <span role="alert" className="text-xs">{msg}</span>}
        </form>
      )}
    </div>
  );
}
