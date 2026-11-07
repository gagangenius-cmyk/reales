"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Entity = "leads" | "listings" | "contacts" | "deals";
interface View { id: string; name: string; filters: Record<string, string>; columns: string[] | null; shared: boolean; isDefault: boolean; mine: boolean; owner?: string }

const tableOf = () => document.querySelector<HTMLTableElement>("main table");
const headersOf = (t: HTMLTableElement | null) => Array.from(t?.tHead?.rows[0]?.cells ?? []).map((c) => (c.textContent ?? "").replace(/[▲▼]/g, "").trim());

/** Hide the columns that are not in `visible` (null = show all). Columns with an empty heading (checkboxes, row actions) always stay. */
function applyColumns(visible: string[] | null) {
  const t = tableOf();
  if (!t) return;
  const heads = headersOf(t);
  for (const row of Array.from(t.rows)) {
    if (row.cells.length !== heads.length) continue; // empty-state or colspan rows
    heads.forEach((h, i) => { row.cells[i]!.style.display = !visible || !h || visible.includes(h) ? "" : "none"; });
  }
}

/**
 * Saved views for a list page: the filters live in the page address, so a view is "open this address", plus a choice of columns. Views are per person;
 * ticking "share" lets colleagues open the same filters (they still only see the records their own access allows).
 */
export function SavedViews({ entity, base }: { entity: Entity; base: string }) {
  const router = useRouter();
  const path = usePathname();
  const [views, setViews] = useState<View[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [share, setShare] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [heads, setHeads] = useState<string[]>([]);
  const [visible, setVisible] = useState<string[] | null>(null);
  const colKey = `sv-cols-${entity}`;
  const visibleRef = useRef<string[] | null>(null);
  visibleRef.current = visible;

  const load = useCallback(async () => {
    const r = await fetch(`/api/v1/saved-views?entity=${entity}`);
    if (r.ok) setViews((await r.json()).views ?? []);
  }, [entity]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await fetch(`/api/v1/saved-views?entity=${entity}`);
      if (!r.ok || !alive) return;
      const list: View[] = (await r.json()).views ?? [];
      setViews(list);
      // Open the personal default once per browser tab when the list is shown with no filters.
      const flag = `sv-applied-${entity}`;
      const def = list.find((v) => v.mine && v.isDefault);
      if (def && !window.location.search && !sessionStorage.getItem(flag)) {
        sessionStorage.setItem(flag, "1");
        const qs = new URLSearchParams(def.filters).toString();
        if (qs) router.replace(`${base}?${qs}`);
        if (def.columns) setVisible(def.columns);
      }
    })();
    try { const saved = localStorage.getItem(colKey); if (saved) setVisible(JSON.parse(saved)); } catch { /* ignore a corrupt value */ }
    return () => { alive = false; };
  }, [entity, base, router, colKey]);

  // Keep the column choice applied when the table re-renders (filters, paging).
  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const run = () => { setHeads(headersOf(tableOf()).filter(Boolean)); applyColumns(visibleRef.current); };
    run();
    const obs = new MutationObserver(() => requestAnimationFrame(run));
    obs.observe(main, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [path]);
  useEffect(() => { applyColumns(visible); }, [visible]);

  function chooseColumns(next: string[] | null) {
    setVisible(next);
    try { next ? localStorage.setItem(colKey, JSON.stringify(next)) : localStorage.removeItem(colKey); } catch { /* storage unavailable */ }
  }
  function openView(v: View) {
    const qs = new URLSearchParams(v.filters).toString();
    if (v.columns) chooseColumns(v.columns);
    router.push(qs ? `${base}?${qs}` : base);
    setOpen(false);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const filters = Object.fromEntries(new URLSearchParams(window.location.search));
    delete filters.page;
    const r = await postJson("/api/v1/saved-views", { entity, name, filters, columns: visible, shared: share, isDefault: makeDefault });
    if (!r.ok) return setMsg(errMsg(r));
    setName(""); setShare(false); setMakeDefault(false); await load();
  }
  async function remove(id: string) { await postJson(`/api/v1/saved-views/${id}`, undefined, "DELETE"); setViews((v) => v.filter((x) => x.id !== id)); }

  return (
    <div className="relative">
      <button className="btn-ghost" aria-expanded={open} onClick={() => setOpen(!open)}>Views and columns</button>
      {open && (
        <div className="card absolute right-0 z-30 mt-2 flex w-96 max-w-[92vw] flex-col gap-3 p-4 shadow-2xl" role="dialog" aria-label="Saved views and columns">
          <div><p className="muted text-xs font-medium">Saved views</p>
            <ul className="mt-1 flex max-h-44 flex-col gap-1 overflow-y-auto">
              {views.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2 text-sm">
                  <button className="truncate text-left underline-offset-2 hover:underline" onClick={() => openView(v)}>{v.name}{v.isDefault && " ★"}{!v.mine && <span className="muted text-xs"> · {v.owner}</span>}{v.mine && v.shared && <span className="muted text-xs"> · shared</span>}</button>
                  {v.mine && <button className="btn-ghost text-xs" onClick={() => remove(v.id)}>Delete</button>}
                </li>))}
              {views.length === 0 && <li className="muted text-sm">None yet. Set filters, then save them here.</li>}
            </ul>
          </div>
          <form onSubmit={save} className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
            <p className="muted text-xs font-medium">Save the current filters{visible ? " and columns" : ""}</p>
            <input className="input" placeholder="View name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Share with my colleagues</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} /> Open this view by default</label>
            <div className="flex items-center gap-3"><button className="btn" disabled={!name.trim()}>Save view</button><p role="alert" className="err text-xs">{msg}</p></div>
          </form>
          {heads.length > 0 && (
            <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
              <div className="flex items-center justify-between"><p className="muted text-xs font-medium">Columns</p><button className="btn-ghost text-xs" onClick={() => chooseColumns(null)}>Show all</button></div>
              <div className="mt-1 grid grid-cols-2 gap-1 text-sm">
                {heads.map((h) => {
                  const on = !visible || visible.includes(h);
                  return <label key={h} className="flex items-center gap-2"><input type="checkbox" checked={on} onChange={(e) => { const cur = visible ?? heads; chooseColumns(e.target.checked ? [...new Set([...cur, h])] : cur.filter((x) => x !== h)); }} />{h}</label>;
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
