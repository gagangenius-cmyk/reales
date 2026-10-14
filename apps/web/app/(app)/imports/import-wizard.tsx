"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Kind = "contacts" | "leads" | "units";
interface Summary { id: string; status: string; totalRows: number; validRows: number; errorRows: number; committedRows: number; skippedRows: number; errors: Array<{ row: number; message: string }>; preview: any[] }

/** Two steps, on purpose: check the file (nothing is created), look at the problems, then confirm. */
export function ImportWizard() {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("contacts");
  const [file, setFile] = useState<File | null>(null);
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "error">("skip");
  const [job, setJob] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setJob(null);
    const csv = await file.text();
    const r = await postJson("/api/v1/imports", { kind, filename: file.name, csv, onDuplicate });
    setBusy(false);
    if (!r.ok) return setError(errMsg(r));
    setJob(r.data);
  }
  async function act(path: "commit" | "cancel") {
    if (!job) return;
    setBusy(true);
    setError(null);
    const r = await postJson(`/api/v1/imports/${job.id}/${path}`);
    setBusy(false);
    if (!r.ok) return setError(errMsg(r));
    setJob(r.data);
    router.refresh();
  }

  return (
    <div className="card flex flex-col gap-3 p-4">
      <h2 className="font-semibold">Import from CSV</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Data<select className="input mt-1" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setJob(null); }}><option value="contacts">Contacts</option><option value="leads">Leads</option><option value="units">Units</option></select></label>
        <label className="text-sm">CSV file<input className="input mt-1" type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setJob(null); }} /></label>
        {kind === "contacts" && <label className="text-sm">If the contact already exists<select className="input mt-1" value={onDuplicate} onChange={(e) => setOnDuplicate(e.target.value as "skip" | "error")}><option value="skip">Skip the row</option><option value="error">Reject the row</option></select></label>}
        <button className="btn" onClick={check} disabled={!file || busy}>{busy && !job ? "Checking..." : "Check file"}</button>
        <a className="btn-ghost text-sm" href={`/api/v1/imports/template?kind=${kind}`}>Download template</a>
      </div>
      {error && <p role="alert" className="err text-sm">{error}</p>}
      {job && (
        <div className="rounded border p-3 text-sm">
          <p><strong>{job.totalRows}</strong> rows read: <strong>{job.validRows}</strong> ready, <strong>{job.errorRows}</strong> with problems.
            {job.status === "committed" && <> Created <strong>{job.committedRows}</strong>, skipped {job.skippedRows} existing.</>}
            {job.status === "cancelled" && <> Import cancelled.</>}
            {job.status === "failed" && <> Nothing could be created.</>}
          </p>
          {job.errors.length > 0 && (
            <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-xs">{job.errors.map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}</ul>
          )}
          {job.status === "validated" && (
            <div className="mt-3 flex gap-2">
              <button className="btn" onClick={() => act("commit")} disabled={busy || job.validRows === 0}>{busy ? "Importing..." : `Import ${job.validRows} rows`}</button>
              <button className="btn-ghost" onClick={() => act("cancel")} disabled={busy}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
