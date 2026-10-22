"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export interface CItem { id: string; title: string; guidance: string | null; required: boolean; gateStage: string; status: "pending" | "done" | "waived"; dueAt: string | null; assigneeEmail: string | null; waivedReason: string | null; note: string | null }

export function DealChecklist({ dealId, items, canUpdate, canWaive, open }: { dealId: string; items: CItem[]; canUpdate: boolean; canWaive: boolean; open: boolean }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [waiving, setWaiving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const done = items.filter((i) => i.status !== "pending").length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const editable = canUpdate && open;

  async function patch(id: string, body: Record<string, unknown>) {
    setErr(null);
    const r = await postJson(`/api/v1/deals/${dealId}/checklist/${id}`, body, "PATCH");
    if (!r.ok) return setErr(errMsg(r));
    setWaiving(null); setReason("");
    router.refresh();
  }
  async function add(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const r = await postJson(`/api/v1/deals/${dealId}/checklist`, { title: title.trim() });
    if (!r.ok) return setErr(errMsg(r));
    setTitle(""); router.refresh();
  }
  const now = Date.now();
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div><h2 className="font-semibold">Checklist</h2><p className="muted text-xs">{done} of {items.length} complete. Required items marked &ldquo;before&hellip;&rdquo; block that stage until done or waived.</p></div>
        <span className="badge">{pct}%</span>
      </div>
      <div className="mb-3 h-2 overflow-hidden rounded-full" style={{ background: "var(--card-2)" }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full" style={{ width: `${pct}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-2))" }} /></div>
      <ul className="flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>
        {items.map((i) => {
          const late = i.status === "pending" && i.dueAt && new Date(i.dueAt).getTime() < now;
          return (
            <li key={i.id} className="flex flex-col gap-1 py-2.5">
              <div className="flex items-start gap-3">
                <input type="checkbox" className="mt-1" checked={i.status === "done"} disabled={!editable || i.status === "waived"} aria-label={`Mark "${i.title}" done`} onChange={(e) => patch(i.id, { status: e.target.checked ? "done" : "pending" })} />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${i.status !== "pending" ? "muted line-through" : "font-medium"}`}>{i.title}{!i.required && <span className="muted"> (optional)</span>}</p>
                  <p className="muted text-xs">
                    {i.gateStage !== "none" && <span className="badge badge-gray mr-2">before {i.gateStage}</span>}
                    {i.status === "waived" && <span className="badge badge-warn mr-2">waived: {i.waivedReason}</span>}
                    {i.dueAt && <span className={late ? "err font-semibold" : ""}>{late ? "Overdue " : "Due "}{new Date(i.dueAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short" })}</span>}
                    {i.assigneeEmail && <span> &middot; {i.assigneeEmail}</span>}
                  </p>
                  {i.guidance && <p className="muted text-xs">{i.guidance}</p>}
                </div>
                {editable && canWaive && i.status === "pending" && <button className="btn-ghost text-xs" onClick={() => setWaiving(i.id)}>Waive</button>}
              </div>
              {waiving === i.id && (
                <form className="ml-7 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) void patch(i.id, { status: "waived", reason: reason.trim() }); }}>
                  <input className="input" placeholder="Why can this be waived?" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /><button className="btn" disabled={!reason.trim()}>Waive</button><button type="button" className="btn-ghost" onClick={() => setWaiving(null)}>Cancel</button>
                </form>
              )}
            </li>
          );
        })}
        {items.length === 0 && <li className="muted py-2 text-sm">No checklist on this deal. Add the starter checklists under Deal checklists, or add items here.</li>}
      </ul>
      {editable && <form className="mt-3 flex gap-2" onSubmit={add}><input className="input" placeholder="Add a checklist item" value={title} onChange={(e) => setTitle(e.target.value)} /><button className="btn-ghost" disabled={!title.trim()}>Add</button></form>}
      {err && <p role="alert" className="err mt-2 text-sm">{err}</p>}
    </div>
  );
}
