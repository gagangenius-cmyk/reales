"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

interface Hit { kind: string; id: string; title: string; subtitle: string; href: string }
const KIND: Record<string, string> = { contact: "Contacts", lead: "Leads", unit: "Units", listing: "Listings", deal: "Deals" };

/** Ctrl/Cmd+K: search contacts (name, email, any phone), leads, units, listings and deals, and jump to pages. */
export function CommandPalette({ pages }: { pages: { href: string; label: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (open) { setQ(""); setHits([]); setIdx(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) { setHits([]); return; }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/v1/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        const j = await r.json();
        setHits(r.ok ? j.hits : []); setIdx(0);
      } catch { /* aborted */ } finally { setLoading(false); }
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, open]);

  const jump = pages.filter((p) => q.trim().length > 0 && p.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 4);
  const items: { href: string; title: string; subtitle: string; group: string }[] = [
    ...jump.map((p) => ({ href: p.href, title: p.label, subtitle: "Go to page", group: "Pages" })),
    ...hits.map((h) => ({ href: h.href, title: h.title, subtitle: h.subtitle, group: KIND[h.kind] ?? h.kind })),
  ];
  const go = (href: string) => { setOpen(false); router.push(href); };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost flex items-center gap-2 text-sm" aria-label="Search (Ctrl+K)">
        <Search size={15} aria-hidden /><span className="muted hidden sm:inline">Search...</span><kbd className="muted hidden rounded border px-1.5 text-xs sm:inline" style={{ borderColor: "var(--border)" }}>Ctrl K</kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="card w-full max-w-xl overflow-hidden shadow-2xl">
            <div className="flex items-center gap-2 border-b px-4" style={{ borderColor: "var(--border)" }}>
              <Search size={16} aria-hidden className="muted" />
              <input ref={input} className="w-full bg-transparent py-3.5 outline-none" placeholder="Search name, phone, email, unit, listing, deal..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search"
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
                  if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
                  if (e.key === "Enter" && items[idx]) go(items[idx]!.href);
                }} />
              {loading && <span className="muted text-xs">...</span>}
            </div>
            <ul className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
              {items.map((it, i) => (
                <li key={`${it.group}-${it.href}-${i}`} role="option" aria-selected={i === idx}>
                  {(i === 0 || items[i - 1]!.group !== it.group) && <p className="muted px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide">{it.group}</p>}
                  <button type="button" onMouseEnter={() => setIdx(i)} onClick={() => go(it.href)} className="flex w-full flex-col rounded-lg px-3 py-2 text-left text-sm" style={{ background: i === idx ? "var(--accent-soft)" : undefined }}>
                    <span className="font-medium">{it.title}</span><span className="muted text-xs">{it.subtitle}</span>
                  </button>
                </li>
              ))}
              {q.trim().length >= 2 && !loading && items.length === 0 && <li className="muted p-4 text-center text-sm">Nothing found for &ldquo;{q}&rdquo;.</li>}
              {q.trim().length < 2 && <li className="muted p-4 text-center text-sm">Type at least 2 characters. Phone numbers match any format.</li>}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
