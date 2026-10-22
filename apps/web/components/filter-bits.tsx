import Link from "next/link";
import type { ReactNode } from "react";

/** Overview | List (| Board) switcher shared by the Leads and Listings pages. */
export function ViewTabs({ base, active, extra = [] }: { base: string; active: "overview" | "list" | "board" | "map"; extra?: { key: "board" | "map"; label: string; href: string }[] }) {
  const tabs = [{ key: "overview", label: "Overview", href: `${base}/overview` }, { key: "list", label: "List", href: base }, ...extra];
  return (
    <nav className="inline-flex rounded-lg border p-0.5 text-sm" style={{ borderColor: "var(--border)" }} aria-label="View">
      {tabs.map((t) => <Link key={t.key} className={`rounded-md px-3 py-1.5 ${active === t.key ? "btn" : ""}`} href={t.href} aria-current={active === t.key ? "page" : undefined}>{t.label}</Link>)}
    </nav>
  );
}

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`text-sm ${wide ? "grow" : ""}`}><span className="muted text-xs font-medium">{label}</span><div className="mt-1">{children}</div></label>;
}

export function Sel({ name, value, options, any = "Any" }: { name: string; value?: string; options: ([string, string] | string)[]; any?: string }) {
  return (
    <select className="input" name={name} defaultValue={value ?? ""}>
      <option value="">{any}</option>
      {options.map((o) => { const [v, l] = typeof o === "string" ? [o, o] : o; return <option key={v} value={v}>{l}</option>; })}
    </select>
  );
}

export const Num = ({ name, value, placeholder }: { name: string; value?: number; placeholder?: string }) => <input className="input" type="number" min={0} name={name} defaultValue={value ?? ""} placeholder={placeholder} />;
export const Check = ({ name, checked, label }: { name: string; checked?: boolean; label: string }) => <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={name} value="1" defaultChecked={checked} />{label}</label>;

/** Active filters shown as removable chips so the person can see why a list is short. */
export function ActiveChips({ chips }: { chips: { label: string; href: string }[] }) {
  if (!chips.length) return null;
  return <div className="flex flex-wrap gap-2 text-xs" aria-label="Active filters">{chips.map((c) => <Link key={c.label} href={c.href} className="badge" title="Remove this filter">{c.label} &times;</Link>)}</div>;
}

export const num = (v?: string) => { if (v === undefined || v === "") return undefined; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined; };
export const pick = <T extends string>(v: string | undefined, allowed: readonly T[]) => (allowed as readonly string[]).includes(v ?? "") ? (v as T) : undefined;
export const date = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
export const list = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10) : undefined);
export const qs = (m: Record<string, string | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(m)) if (v) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ""; };

/** Clickable column header: first click applies `asc`, the next `desc`; the arrow shows the active direction. */
export function SortTh({ label, sort, asc, desc, href }: { label: string; sort?: string; asc: string; desc: string; href: (sort: string) => string }) {
  const on = sort === asc ? "asc" : sort === desc ? "desc" : null;
  return <th aria-sort={on === "asc" ? "ascending" : on === "desc" ? "descending" : "none"}><Link href={href(on === "asc" ? desc : asc)} className="whitespace-nowrap">{label}<span aria-hidden>{on === "asc" ? " ▲" : on === "desc" ? " ▼" : ""}</span></Link></th>;
}
