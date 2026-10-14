"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function DsrCreate({ contacts }: { contacts: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const [kind, setKind] = useState("access");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await postJson("/api/v1/dsr-requests", { contactId, kind });
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-3 p-4">
      <label className="grow text-sm">Log a data request from<select className="input mt-1 w-full" value={contactId} onChange={(e) => setContactId(e.target.value)}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      <label className="text-sm">Type<select className="input mt-1" value={kind} onChange={(e) => setKind(e.target.value)}><option value="access">Access (copy of data)</option><option value="erasure">Erasure</option><option value="rectification">Rectification</option><option value="restriction">Restriction</option></select></label>
      <button className="btn" disabled={!contactId}>Log request</button>
      {error && <p role="alert" className="err w-full text-sm">{error}</p>}
    </form>
  );
}

export function DsrActions({ id, kind }: { id: string; kind: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [download, setDownload] = useState<string | null>(null);
  async function go(path: string, body?: unknown) {
    setMsg(null);
    const r = await postJson(`/api/v1/dsr-requests/${id}/${path}`, body);
    if (!r.ok) return setMsg(r.data?.error?.code === "step_up_required" ? "Re-verify your second factor first (step-up)." : errMsg(r));
    if (path === "access") setDownload(URL.createObjectURL(new Blob([JSON.stringify(r.data.result, null, 2)], { type: "application/json" })));
    else router.refresh();
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {kind === "access" && <button className="btn-ghost text-xs" onClick={() => go("access")}>Prepare data package</button>}
      {kind === "erasure" && <button className="btn-ghost text-xs" onClick={() => { if (window.confirm("Anonymise this person's data? This cannot be undone. Financial and AML records are retained and listed in the result.")) go("erasure"); }}>Erase (anonymise)</button>}
      {(kind === "rectification" || kind === "restriction") && <button className="btn-ghost text-xs" onClick={() => { const note = window.prompt("What was done?"); if (note) go("close", { outcome: "completed", note }); }}>Mark handled</button>}
      <button className="btn-ghost text-xs" onClick={() => { const note = window.prompt("Reason for rejecting this request?"); if (note) go("close", { outcome: "rejected", note }); }}>Reject</button>
      {download && <><a className="btn text-xs" href={download} download={`data-package-${id.slice(0, 8)}.json`}>Download package</a><button className="btn-ghost text-xs" onClick={() => router.refresh()}>Close</button></>}
      {msg && <span role="alert" className="err text-xs">{msg}</span>}
    </span>
  );
}
