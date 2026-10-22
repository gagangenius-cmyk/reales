"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";
import type { AgentOpt, EditTarget } from "./listing-drawer";
import type { ReactNode } from "react";
import { ListingRow, type ListingRowData } from "./listing-row";

export interface TableRow { data: ListingRowData; canPublish: boolean; edit?: { target: EditTarget; agents: AgentOpt[]; canReassign: boolean } }

/** Listings list with row selection: bulk actions plus the client PDF (availability sheet) built from whatever is ticked. */
export function ListingsTable({ rows, canBulk, canPdf, agents, defaults, head }: { head: ReactNode; rows: TableRow[]; canBulk: boolean; canPdf: boolean; agents: AgentOpt[]; defaults: { clientName?: string; leadId?: string } }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dlg, setDlg] = useState(!!defaults.clientName || !!defaults.leadId);
  const [f, setF] = useState({ clientName: defaults.clientName ?? "", title: "", notes: "", layout: "both", showPrice: true, includePhotos: true, includeFloorPlans: true, validityDays: 7 });
  const ids = rows.map((r) => r.data.id);
  const all = ids.length > 0 && ids.every((i) => sel.has(i));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectable = canBulk || canPdf;

  async function bulk(action: Record<string, unknown>, label: string) {
    setBusy(true); setMsg(null);
    const r = await postJson("/api/v1/listings/bulk", { ids: [...sel], action });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    const { done, failed } = r.data as { done: number; failed: { id: string; reason: string }[] };
    setMsg({ ok: failed.length === 0, text: `${label}: ${done} done${failed.length ? `, ${failed.length} failed (${[...new Set(failed.map((x) => x.reason))].slice(0, 2).join("; ")})` : ""}.` });
    setSel(new Set()); router.refresh();
  }

  async function pdf(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const body = { listingIds: [...sel], ...(f.clientName.trim() ? { clientName: f.clientName.trim() } : {}), ...(f.title.trim() ? { title: f.title.trim() } : {}), ...(f.notes.trim() ? { notes: f.notes.trim() } : {}), ...(defaults.leadId ? { leadId: defaults.leadId } : {}), layout: f.layout, showPrice: f.showPrice, includePhotos: f.includePhotos, includeFloorPlans: f.includeFloorPlans, validityDays: f.validityDays };
    const res = await fetch("/api/v1/listings/shortlist-pdf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) { let m = "Could not create the PDF"; try { m = (await res.json()).error?.message ?? m; } catch { /* not json */ } return setMsg({ ok: false, text: m }); }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a"); a.href = url; a.download = `${(f.clientName || "shortlist").replace(/[^\w-]+/g, "_")}-properties.pdf`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    setMsg({ ok: true, text: `PDF created for ${sel.size} listing${sel.size === 1 ? "" : "s"}.` }); setDlg(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {selectable && sel.size > 0 && (
        <div className="card sticky top-16 z-10 flex flex-wrap items-center gap-2 p-3 text-sm" role="toolbar" aria-label="Selected listings">
          <b>{sel.size} selected</b>
          {canPdf && <button className="btn" disabled={busy || sel.size > 30} onClick={() => setDlg(true)} title={sel.size > 30 ? "Select at most 30" : undefined}>Create client PDF</button>}
          {canBulk && (
            <>
              <button className="btn-ghost" disabled={busy} onClick={() => bulk({ type: "publish" }, "Published")}>Publish</button>
              <button className="btn-ghost" disabled={busy} onClick={() => bulk({ type: "unpublish" }, "Unpublished")}>Unpublish</button>
              <button className="btn-ghost" disabled={busy} onClick={() => bulk({ type: "refresh" }, "Refreshed")}>Refresh</button>
              <button className="btn-ghost" disabled={busy} onClick={() => bulk({ type: "archive" }, "Archived")}>Archive</button>
              <select className="input w-auto py-1" disabled={busy} defaultValue="" aria-label="Close selected as" onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v) void bulk({ type: "close", outcome: v }, `Closed as ${v}`); }}>
                <option value="">Close as...</option><option value="sold">Sold</option><option value="rented">Rented</option><option value="withdrawn">Withdrawn</option>
              </select>
              <button className="btn-ghost" disabled={busy} onClick={() => bulk({ type: "feature", value: true }, "Featured")}>Feature</button>
              <button className="btn-ghost" disabled={busy} onClick={() => bulk({ type: "feature", value: false }, "Unfeatured")}>Unfeature</button>
              <select className="input w-auto py-1" disabled={busy} defaultValue="" aria-label="Reassign selected to" onChange={(e) => { if (e.target.value) { void bulk({ type: "assign", userId: e.target.value }, "Reassigned"); e.target.value = ""; } }}>
                <option value="">Assign to...</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
              </select>
            </>
          )}
          <button className="btn-ghost ml-auto" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p>}
      {dlg && (
        <form className="card flex flex-col gap-3 p-4" onSubmit={pdf} aria-label="Client PDF options">
          <div className="flex items-baseline justify-between"><h2 className="text-base font-semibold">Client PDF for {sel.size} listing{sel.size === 1 ? "" : "s"}</h2><button type="button" className="btn-ghost text-xs" onClick={() => setDlg(false)}>Close</button></div>
          {sel.size === 0 && <p className="err text-sm">Tick the listings to include first.</p>}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm"><span className="muted text-xs font-medium">Client name</span><input className="input mt-1" value={f.clientName} maxLength={120} onChange={(e) => setF({ ...f, clientName: e.target.value })} placeholder="Prepared for..." /></label>
            <label className="text-sm"><span className="muted text-xs font-medium">Title</span><input className="input mt-1" value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Properties for you" /></label>
            <label className="text-sm"><span className="muted text-xs font-medium">Layout</span>
              <select className="input mt-1" value={f.layout} onChange={(e) => setF({ ...f, layout: e.target.value })}><option value="both">Summary table and property pages</option><option value="table">Availability table only</option><option value="detailed">Property pages only</option></select></label>
          </div>
          <label className="text-sm"><span className="muted text-xs font-medium">Note to the client (optional)</span><textarea className="input mt-1" rows={2} maxLength={1500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.showPrice} onChange={(e) => setF({ ...f, showPrice: e.target.checked })} />Show prices</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.includePhotos} onChange={(e) => setF({ ...f, includePhotos: e.target.checked })} />Photos</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.includeFloorPlans} onChange={(e) => setF({ ...f, includeFloorPlans: e.target.checked })} />Floor plans</label>
            <label className="flex items-center gap-2">Valid for<input className="input w-16 py-1" type="number" min={1} max={90} value={f.validityDays} onChange={(e) => setF({ ...f, validityDays: Math.min(90, Math.max(1, Number(e.target.value) || 7)) })} />days</label>
          </div>
          <div><button className="btn" disabled={busy || sel.size === 0}>{busy ? "Creating..." : "Download PDF"}</button></div>
          {defaults.leadId && <p className="muted text-xs">This will also be noted on the lead&apos;s activity.</p>}
        </form>
      )}
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr>
            {selectable && <th className="w-8"><input type="checkbox" aria-label="Select all on this page" checked={all} onChange={() => setSel(all ? new Set() : new Set(ids))} /></th>}
            {head}
          </tr></thead>
          <tbody>
            {rows.map((r) => <ListingRow key={r.data.id} listing={r.data} canPublish={r.canPublish} edit={r.edit} selected={sel.has(r.data.id)} onToggle={selectable ? () => toggle(r.data.id) : undefined} />)}
            {rows.length === 0 && <tr><td colSpan={9} className="muted">No listings match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
