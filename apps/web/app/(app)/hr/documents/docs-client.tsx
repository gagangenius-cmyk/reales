"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lbl, useAction } from "@/components/hr-ui";

interface Doc { id: string; title: string; category: string; fileName: string; sizeBytes: number; expiresOn: string | null; visibility: string; employeeName: string; createdAt: string }
const today = () => new Date().toISOString().slice(0, 10);

export function DocsClient({ docs, employees, categories, canManage, employee, category, expiring }: { docs: Doc[]; employees: { id: string; name: string }[]; categories: string[]; canManage: boolean; employee?: string; category?: string; expiring?: string }) {
  const router = useRouter();
  const { busy, run, Msg, post } = useAction();
  const [f, setF] = useState({ employeeId: employee ?? "", title: "", category: "contract", expiresOn: "", visibility: "employee" });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function upload(e: React.FormEvent) {
    e.preventDefault(); if (!file) return;
    setErr(null);
    const fd = new FormData(); fd.append("file", file); fd.append("title", f.title || file.name); fd.append("category", f.category); fd.append("visibility", f.employeeId ? f.visibility : f.visibility === "hr_only" ? "hr_only" : "company");
    if (f.employeeId) fd.append("employeeId", f.employeeId); if (f.expiresOn) fd.append("expiresOn", f.expiresOn);
    const r = await fetch("/api/v1/hr/documents", { method: "POST", body: fd, headers: { "idempotency-key": crypto.randomUUID() } });
    if (!r.ok) { let m = "Upload failed"; try { m = (await r.json()).error?.message ?? m; } catch { /* not json */ } return setErr(m); }
    setFile(null); setF({ ...f, title: "", expiresOn: "" }); router.refresh();
  }
  const go = (o: Record<string, string>) => router.push(`/hr/documents?${new URLSearchParams(Object.fromEntries(Object.entries({ employee, category, expiring, ...o }).filter(([, v]) => v)) as Record<string, string>)}`);
  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <form onSubmit={upload} className="card grid gap-3 p-4 sm:grid-cols-4">
          <h2 className="font-semibold sm:col-span-4">Upload a document</h2>
          <Lbl label="Belongs to"><select className="input" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Company (policy, handbook)</option>{employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Lbl>
          <Lbl label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Employment contract" /></Lbl>
          <Lbl label="Category"><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{categories.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</select></Lbl>
          <Lbl label="Expires (optional)"><input className="input" type="date" value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} /></Lbl>
          <Lbl label="Who can see it"><select className="input" value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}>{f.employeeId ? <><option value="employee">The employee and HR</option><option value="hr_only">HR only</option><option value="company">Everyone</option></> : <><option value="company">Everyone</option><option value="hr_only">HR only</option></>}</select></Lbl>
          <Lbl label="File (PDF or image)" wide><input type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Lbl>
          <div className="flex items-end"><button className="btn" disabled={busy || !file}>Upload</button></div>
          {err && <p role="alert" className="err text-sm sm:col-span-4">{err}</p>}
        </form>
      )}
      <Msg />
      <div className="card flex flex-wrap items-end gap-3 p-3 text-sm">
        {canManage && <Lbl label="Employee"><select className="input" value={employee ?? ""} onChange={(e) => go({ employee: e.target.value })}><option value="">Everyone</option>{employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Lbl>}
        <Lbl label="Category"><select className="input" value={category ?? ""} onChange={(e) => go({ category: e.target.value })}><option value="">All</option>{categories.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</select></Lbl>
        <Lbl label="Expiring"><select className="input" value={expiring ?? ""} onChange={(e) => go({ expiring: e.target.value })}><option value="">Any time</option><option value="30">Within 30 days</option><option value="60">Within 60 days</option><option value="90">Within 90 days</option><option value="0">Already expired</option></select></Lbl>
      </div>
      <div className="card overflow-x-auto" data-server-table>
        <table className="t"><thead><tr><th>Document</th><th>Belongs to</th><th>Category</th><th>Expires</th><th>Visible to</th><th /></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}><td className="font-medium"><a href={`/api/v1/hr/documents/${d.id}`}>{d.title}</a><div className="muted text-xs font-normal">{d.fileName} - {(d.sizeBytes / 1024).toFixed(0)} KB</div></td><td>{d.employeeName}</td><td>{d.category.replace("_", " ")}</td>
                <td className={d.expiresOn && d.expiresOn.slice(0, 10) < today() ? "err" : ""}>{d.expiresOn ? d.expiresOn.slice(0, 10) : "-"}</td><td>{d.visibility.replace("_", " ")}</td>
                <td className="text-right">{canManage && <button className="btn-ghost text-xs err" disabled={busy} onClick={() => confirm(`Delete "${d.title}"?`) && run(() => post(`/api/v1/hr/documents/${d.id}`, undefined, "DELETE"), "Deleted.")}>Delete</button>}</td></tr>
            ))}
            {docs.length === 0 && <tr><td colSpan={6} className="muted">No documents.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
