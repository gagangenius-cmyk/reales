"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Folder { id: string; name: string; description: string | null; restricted: boolean; defaultExpiryDays: number | null; retentionDays: number | null; allowedKinds: string[] | null; requiresLink: boolean; documents: number }
interface Doc { id: string; title: string; kind: string; folderId: string | null; folderName: string | null; expiresOn: string | null; retainUntil: string | null; createdAt: string }
const KINDS = ["contract", "id_document", "permit", "invoice", "receipt", "other"];
const EMPTY = { name: "", description: "", restricted: false, defaultExpiryDays: "", retentionDays: "", allowedKinds: [] as string[], requiresLink: false };
const today = () => new Date().toISOString().slice(0, 10);

export function LibraryClient({ folders, docs, canManage, folder, q, expiring }: { folders: Folder[]; docs: Doc[]; canManage: boolean; folder?: string; q?: string; expiring?: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<(typeof EMPTY & { id?: string }) | null>(null);
  const [search, setSearch] = useState(q ?? "");
  const [up, setUp] = useState({ title: "", kind: "other", folderId: folder ?? "" });
  const [file, setFile] = useState<File | null>(null);
  const go = (o: Record<string, string>) => router.push(`/documents?${new URLSearchParams(Object.fromEntries(Object.entries({ folder, q, expiring, ...o }).filter(([, v]) => v)) as Record<string, string>)}`);
  const num = (v: string) => (v === "" ? null : Number(v));
  async function run(p: Promise<{ ok: boolean; data: any; status: number }>, done: string) { setBusy(true); setMsg(null); const r = await p; setBusy(false); if (!r.ok) { setMsg({ ok: false, text: errMsg(r) }); return false; } setMsg({ ok: true, text: done }); router.refresh(); return true; }
  async function upload(e: React.FormEvent) {
    e.preventDefault(); if (!file) return;
    setBusy(true); setMsg(null);
    const fd = new FormData(); fd.set("file", file); fd.set("title", up.title || file.name); fd.set("kind", up.kind); if (up.folderId) fd.set("folderId", up.folderId);
    const r = await fetch("/api/v1/documents", { method: "POST", body: fd, headers: { "idempotency-key": crypto.randomUUID() } });
    setBusy(false);
    if (!r.ok) { const j = await r.json().catch(() => null); return setMsg({ ok: false, text: j?.error?.message ?? "Upload failed" }); }
    setFile(null); setUp({ ...up, title: "" }); setMsg({ ok: true, text: "Uploaded." }); router.refresh();
  }
  return (
    <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
      <aside className="flex flex-col gap-2">
        <button className={folder ? "btn-ghost justify-start" : "btn justify-start"} onClick={() => go({ folder: "" })}>All documents</button>
        {folders.map((f) => <button key={f.id} className={folder === f.id ? "btn justify-start" : "btn-ghost justify-start"} onClick={() => go({ folder: f.id })}>{f.name} <span className="ml-auto opacity-70">{f.documents}</span>{f.restricted && <span title="Restricted"> &#128274;</span>}</button>)}
        {canManage && <button className="btn-ghost text-sm" onClick={() => setEdit({ ...EMPTY })}>+ New folder</button>}
      </aside>
      <div className="flex flex-col gap-4">
        {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p>}
        {canManage && folder && (() => { const f = folders.find((x) => x.id === folder); return f ? (
          <div className="card flex flex-wrap items-center justify-between gap-3 p-3 text-sm"><div><b>{f.name}</b><span className="muted block">{[f.restricted && "restricted to document managers", f.defaultExpiryDays && `expires after ${f.defaultExpiryDays} days`, f.retentionDays && `kept ${f.retentionDays} days`, f.allowedKinds?.length && `only ${f.allowedKinds.join(", ").replace(/_/g, " ")}`, f.requiresLink && "must be attached to a record"].filter(Boolean).join(" - ") || "No special rules"}</span></div>
            <button className="btn-ghost" onClick={() => setEdit({ id: f.id, name: f.name, description: f.description ?? "", restricted: f.restricted, defaultExpiryDays: f.defaultExpiryDays ? String(f.defaultExpiryDays) : "", retentionDays: f.retentionDays ? String(f.retentionDays) : "", allowedKinds: f.allowedKinds ?? [], requiresLink: f.requiresLink })}>Edit rules</button></div>
        ) : null; })()}
        {edit && (
          <form className="card grid gap-3 p-4 text-sm sm:grid-cols-3" onSubmit={async (e) => { e.preventDefault(); if (await run(postJson("/api/v1/document-folders", { ...(edit.id ? { id: edit.id } : {}), name: edit.name, description: edit.description || null, restricted: edit.restricted, defaultExpiryDays: num(edit.defaultExpiryDays), retentionDays: num(edit.retentionDays), allowedKinds: edit.allowedKinds.length ? edit.allowedKinds : null, requiresLink: edit.requiresLink }), "Folder saved.")) setEdit(null); }}>
            <h2 className="font-semibold sm:col-span-3">{edit.id ? "Folder rules" : "New folder"}</h2>
            <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Name</span><input className="input" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Expires after (days, optional)</span><input className="input" type="number" min="1" value={edit.defaultExpiryDays} onChange={(e) => setEdit({ ...edit, defaultExpiryDays: e.target.value })} /></label>
            <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Must be kept for (days, optional)</span><input className="input" type="number" min="1" value={edit.retentionDays} onChange={(e) => setEdit({ ...edit, retentionDays: e.target.value })} /></label>
            <label className="flex flex-col gap-1.5 sm:col-span-3"><span className="muted text-xs font-medium">Description</span><input className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
            <fieldset className="sm:col-span-3"><legend className="muted mb-1 text-xs font-medium">Accepted kinds (none ticked = any)</legend><div className="flex flex-wrap gap-3">{KINDS.map((k) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={edit.allowedKinds.includes(k)} onChange={(e) => setEdit({ ...edit, allowedKinds: e.target.checked ? [...edit.allowedKinds, k] : edit.allowedKinds.filter((x) => x !== k) })} />{k.replace("_", " ")}</label>)}</div></fieldset>
            <label className="flex items-center gap-2"><input type="checkbox" checked={edit.restricted} onChange={(e) => setEdit({ ...edit, restricted: e.target.checked })} />Restricted: only tenant-wide document managers can open it</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={edit.requiresLink} onChange={(e) => setEdit({ ...edit, requiresLink: e.target.checked })} />Every document must be attached to a lead, contact, listing or deal</label>
            <div className="flex gap-2 sm:col-span-3"><button className="btn" disabled={busy}>Save</button><button type="button" className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button></div>
          </form>
        )}
        {canManage && (
          <form onSubmit={upload} className="card flex flex-wrap items-end gap-3 p-3 text-sm">
            <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">File</span><input type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
            <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Title</span><input className="input" value={up.title} onChange={(e) => setUp({ ...up, title: e.target.value })} /></label>
            <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Kind</span><select className="input" value={up.kind} onChange={(e) => setUp({ ...up, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}</select></label>
            <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Folder</span><select className="input" value={up.folderId} onChange={(e) => setUp({ ...up, folderId: e.target.value })}><option value="">No folder</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
            <button className="btn" disabled={busy || !file}>Upload</button>
          </form>
        )}
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); go({ q: search }); }}>
          <input className="input w-64" type="search" placeholder="Search by title" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search documents" />
          <select className="input w-auto" value={expiring ?? ""} onChange={(e) => go({ expiring: e.target.value })} aria-label="Expiry filter"><option value="">Any expiry</option><option value="30">Expiring within 30 days</option><option value="0">Already expired</option></select>
          <button className="btn-ghost">Search</button>
        </form>
        <div className="card overflow-x-auto" data-server-table>
          <table className="t"><thead><tr><th>Document</th><th>Kind</th><th>Folder</th><th>Expires</th><th>Kept until</th><th /></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}><td className="font-medium"><a href={`/api/v1/documents/${d.id}/download`}>{d.title}</a><div className="muted text-xs font-normal">{d.createdAt.slice(0, 10)}</div></td><td>{d.kind.replace("_", " ")}</td><td>{d.folderName ?? "-"}</td>
                  <td className={d.expiresOn && d.expiresOn.slice(0, 10) < today() ? "err" : ""}>{d.expiresOn ? d.expiresOn.slice(0, 10) : "-"}</td><td>{d.retainUntil ? d.retainUntil.slice(0, 10) : "-"}</td>
                  <td className="text-right">{canManage && <select className="input w-auto py-1 text-xs" value={d.folderId ?? ""} aria-label={`Move ${d.title}`} onChange={(e) => run(postJson(`/api/v1/documents/${d.id}/move`, { folderId: e.target.value || null }), "Moved.")}><option value="">No folder</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>}</td></tr>
              ))}
              {docs.length === 0 && <tr><td colSpan={6} className="muted">No documents.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
