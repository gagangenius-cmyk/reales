"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Item { id: string; label: string; area: string | null; condition: string; notes: string; meterReading: string | null }
const CONDITIONS = ["na", "good", "fair", "poor", "damaged"];

/**
 * Saves through the same offline-sync endpoint the mobile app uses: each save is one client mutation based on the version loaded, so two people editing
 * the same item get a clear conflict instead of silently overwriting each other.
 */
export function InspectionEditor({ id, status, version, items, canPerform }: { id: string; status: string; version: number; items: Item[]; canPerform: boolean }) {
  const router = useRouter();
  const [rows, setRows] = useState(items);
  const [base, setBase] = useState(version);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const editable = canPerform && ["scheduled", "in_progress"].includes(status);
  const dirty = rows.filter((r, i) => r.condition !== items[i]!.condition || r.notes !== items[i]!.notes);

  async function save() {
    setMsg(null);
    const r = await postJson(`/api/v1/inspections/${id}/sync`, { mutations: [{ clientMutationId: crypto.randomUUID(), baseVersion: base, changes: dirty.map((d) => ({ itemId: d.id, condition: d.condition, notes: d.notes || null })) }] });
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    if (r.data.conflicts.length) return setMsg({ ok: false, text: `${r.data.conflicts.length} item(s) were changed by someone else. Reload the page to see their changes.` });
    setBase(r.data.version);
    setMsg({ ok: true, text: "Saved." });
    router.refresh();
  }
  async function complete() {
    const summary = window.prompt("Summary (optional)") ?? undefined;
    const r = await postJson(`/api/v1/inspections/${id}/complete`, { summary });
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    router.refresh();
  }
  async function sign() {
    const contactId = window.prompt("Contact id of the person signing (tenant or owner)");
    if (!contactId) return;
    const r = await postJson(`/api/v1/inspections/${id}/sign`, { contactId: contactId.trim() });
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    router.refresh();
  }

  return (
    <div className="card overflow-x-auto p-2">
      <table className="t">
        <thead><tr><th>Item</th><th>Area</th><th>Condition</th><th>Notes</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td>{r.label}</td><td>{r.area ?? "-"}</td>
              <td>{editable ? <select className="input" value={r.condition} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, condition: e.target.value } : x)))}>{CONDITIONS.map((c) => <option key={c}>{c}</option>)}</select> : r.condition}</td>
              <td>{editable ? <input className="input w-full" value={r.notes} maxLength={1000} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, notes: e.target.value } : x)))} /> : r.notes || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2 p-2">
        {editable && <button className="btn" disabled={dirty.length === 0} onClick={save}>Save changes</button>}
        {editable && <button className="btn-ghost" onClick={complete}>Mark complete</button>}
        {canPerform && status === "completed" && <button className="btn" onClick={sign}>Record sign-off</button>}
        {msg && <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "" : "err"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
