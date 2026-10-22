"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export interface Item { title: string; guidance?: string | null; required: boolean; gateStage: string; dueOffsetDays: number | null }
export interface Template { id: string; name: string; dealType: string; projectKind: string; active: boolean; items: Item[] }
const GATES: [string, string][] = [["none", "No stage gate"], ["contract", "Before Contract"], ["signed", "Before Signed"], ["payment", "Before Payment"], ["registration", "Before Registration"], ["closed", "Before Closed"]];
const blank = (): Template => ({ id: "", name: "", dealType: "sale", projectKind: "any", active: true, items: [{ title: "", required: true, gateStage: "none", dueOffsetDays: null }] });

export function TemplateEditor({ template }: { template?: Template }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [t, setT] = useState<Template>(template ?? blank());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false); document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [open]);
  const setItem = (i: number, patch: Partial<Item>) => setT({ ...t, items: t.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const move = (i: number, d: number) => { const n = [...t.items]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; setT({ ...t, items: n }); };

  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null); setBusy(true);
    const r = await postJson("/api/v1/checklist-templates", { ...(t.id && { id: t.id }), name: t.name, dealType: t.dealType, projectKind: t.projectKind, active: t.active, items: t.items.filter((x) => x.title.trim()).map((x) => ({ title: x.title, guidance: x.guidance || undefined, required: x.required, gateStage: x.gateStage, dueOffsetDays: x.dueOffsetDays })) });
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r));
    setOpen(false); if (!template) setT(blank()); router.refresh();
  }
  return (
    <>
      <button className={template ? "btn-ghost text-sm" : "btn"} onClick={() => { setOpen(true); setMsg(null); }}>{template ? "Edit" : "+ New checklist"}</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Checklist template">
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={save} className="relative flex h-full w-full max-w-3xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-xl font-semibold">{template ? "Edit checklist" : "New checklist"}</h2><p className="muted text-sm">Copied onto every new deal of this type. A required item with a stage gate blocks the deal from reaching that stage until it is done or waived.</p></header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
              <section className="card grid gap-4 p-4 sm:grid-cols-3">
                <label className="flex flex-col gap-1.5 text-sm sm:col-span-3"><span className="muted text-xs font-medium">Name</span><input className="input" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} required autoFocus /></label>
                <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Deal type</span><select className="input" value={t.dealType} onChange={(e) => setT({ ...t, dealType: e.target.value })}><option value="sale">Sale</option><option value="lease">Lease</option></select></label>
                <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Property</span><select className="input" value={t.projectKind} onChange={(e) => setT({ ...t, projectKind: e.target.value })}><option value="any">Any</option><option value="ready">Ready</option><option value="off_plan">Off-plan</option></select></label>
                <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} /> Active</label>
              </section>
              <section className="flex flex-col gap-2">
                {t.items.map((it, i) => (
                  <div key={i} className="card grid gap-2 p-3 sm:grid-cols-[1fr_9rem_5rem_auto]">
                    <input className="input" placeholder={`Item ${i + 1}, e.g. Buyer passport copy`} value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} aria-label={`Item ${i + 1} title`} />
                    <select className="input" value={it.gateStage} onChange={(e) => setItem(i, { gateStage: e.target.value })} aria-label="Stage gate">{GATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    <input className="input" type="number" min="0" placeholder="Days" value={it.dueOffsetDays ?? ""} onChange={(e) => setItem(i, { dueOffsetDays: e.target.value === "" ? null : Number(e.target.value) })} aria-label="Due after days" title="Due this many days after the deal starts" />
                    <div className="flex items-center gap-1 text-xs">
                      <label className="flex items-center gap-1"><input type="checkbox" checked={it.required} onChange={(e) => setItem(i, { required: e.target.checked })} /> Req.</label>
                      <button type="button" className="btn-ghost px-2" aria-label="Move up" onClick={() => move(i, -1)}>&uarr;</button><button type="button" className="btn-ghost px-2" aria-label="Move down" onClick={() => move(i, 1)}>&darr;</button>
                      <button type="button" className="btn-ghost px-2" aria-label="Remove item" onClick={() => setT({ ...t, items: t.items.filter((_, j) => j !== i) })}>&times;</button>
                    </div>
                    <input className="input sm:col-span-4" placeholder="Guidance for the agent (optional)" value={it.guidance ?? ""} onChange={(e) => setItem(i, { guidance: e.target.value })} aria-label="Guidance" />
                  </div>
                ))}
                <button type="button" className="btn-ghost w-fit" onClick={() => setT({ ...t, items: [...t.items, { title: "", required: true, gateStage: "none", dueOffsetDays: null }] })}>+ Add item</button>
              </section>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p>
              <div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving..." : "Save checklist"}</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}

export function TemplateActions({ id }: { id: string }) {
  const router = useRouter();
  return <button className="btn-ghost text-sm" onClick={async () => { if (confirm("Delete this checklist template? Deals already created keep their items.")) { await postJson(`/api/v1/checklist-templates/${id}`, undefined, "DELETE"); router.refresh(); } }}>Delete</button>;
}

export function InstallStarters() {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-3"><button className="btn-ghost" onClick={async () => { const r = await postJson("/api/v1/checklist-templates", { starter: true }, "PUT"); setMsg(r.ok ? `${r.data.added} starter checklist(s) added.` : errMsg(r)); router.refresh(); }}>Add UAE starter checklists</button>{msg && <span className="muted text-sm">{msg}</span>}</span>
  );
}
