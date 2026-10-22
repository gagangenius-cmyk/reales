"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Row { entity: string; label: string; id: string; title: string; deletedAt: string; deletedBy: string | null }
const dt = (s: string) => new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" });

export function TrashTable({ rows, canPurge }: { rows: Row[]; canPurge: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [step, setStep] = useState<{ row: Row; code: string } | null>(null);

  async function restore(r: Row) {
    setBusy(r.id); setMsg(null);
    const res = await postJson("/api/v1/trash/restore", { entity: r.entity, id: r.id });
    setBusy(null);
    if (!res.ok) return setMsg({ ok: false, text: errMsg(res) });
    setMsg({ ok: true, text: `${r.label} restored.` }); router.refresh();
  }
  async function purge(r: Row) {
    if (!confirm(`Erase "${r.title}" permanently? This cannot be undone.`)) return;
    setBusy(r.id); setMsg(null);
    const res = await postJson("/api/v1/trash/purge", { entity: r.entity, id: r.id });
    setBusy(null);
    if (res.data?.error?.code === "step_up_required") return setStep({ row: r, code: "" });
    if (!res.ok) return setMsg({ ok: false, text: errMsg(res) });
    setMsg({ ok: true, text: `${r.label} erased.` }); router.refresh();
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault(); if (!step) return;
    setBusy(step.row.id);
    const res = await postJson("/api/v1/auth/step-up", { code: step.code.trim() });
    setBusy(null);
    if (!res.ok) return setMsg({ ok: false, text: errMsg(res) });
    const row = step.row; setStep(null); setMsg({ ok: true, text: "Verified. Press Erase again to continue." }); void row;
  }

  return (
    <div className="flex flex-col gap-3">
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p>}
      {step && (
        <form onSubmit={verify} className="card flex flex-wrap items-end gap-3 p-3 text-sm">
          <label><span className="muted text-xs font-medium">Authenticator code to confirm erasing</span><input className="input mt-1 w-40" inputMode="numeric" autoComplete="one-time-code" value={step.code} onChange={(e) => setStep({ ...step, code: e.target.value })} /></label>
          <button className="btn" disabled={!step.code.trim()}>Verify</button><button type="button" className="btn-ghost" onClick={() => setStep(null)}>Cancel</button>
        </form>
      )}
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr><th>Record</th><th>Type</th><th>Deleted</th><th>By</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.entity}-${r.id}`}>
                <td className="font-medium">{r.title}</td><td><span className="badge badge-gray">{r.label}</span></td><td>{dt(r.deletedAt)}</td><td>{r.deletedBy ?? "-"}</td>
                <td className="text-right"><div className="flex justify-end gap-2"><button className="btn" disabled={busy === r.id} onClick={() => restore(r)}>Restore</button>{canPurge && <button className="btn-ghost err" disabled={busy === r.id} onClick={() => purge(r)}>Erase</button>}</div></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted">Trash is empty.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
