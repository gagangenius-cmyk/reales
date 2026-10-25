"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Opt = { id: string; label: string };
type Contact = { id: string; firstName?: string | null; lastName?: string | null; companyName?: string | null; phoneE164?: string | null; email?: string | null };
const cname = (c: Contact) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.phoneE164 || "Contact";

/** Create a portfolio for an owner, and assign units to it (the share and start date decide who gets the rent in owner statements). */
export function PortfolioForms({ portfolios, units }: { portfolios: Opt[]; units: Opt[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [owner, setOwner] = useState<Contact | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Contact[]>([]);
  const [o, setO] = useState({ unitId: "", portfolioId: "", sharePct: "100", fromDate: new Date().toISOString().slice(0, 10) });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (owner || q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(async () => { try { const r = await fetch(`/api/v1/contacts?q=${encodeURIComponent(q.trim())}&limit=6&offset=0`); const j = await r.json(); setFound(r.ok ? j.contacts ?? [] : []); } catch { setFound([]); } }, 250);
    return () => clearTimeout(t);
  }, [q, owner]);

  async function addPortfolio(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    if (!owner) return setMsg("Choose the owner.");
    setBusy(true);
    const r = await postJson("/api/v1/portfolios", { name: name.trim(), ownerContactId: owner.id });
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r));
    setName(""); setOwner(null); setQ(""); setMsg("Portfolio created."); router.refresh();
  }
  async function assign(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    setBusy(true);
    const r = await postJson("/api/v1/ownerships", { unitId: o.unitId, portfolioId: o.portfolioId, sharePct: Number(o.sharePct) || 100, fromDate: o.fromDate });
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r));
    setMsg("Unit assigned."); router.refresh();
  }
  return (
    <details className="card p-3">
      <summary className="cursor-pointer font-medium">Add a portfolio or assign a unit</summary>
      <div className="mt-3 grid gap-5 lg:grid-cols-2">
        <form onSubmit={addPortfolio} className="flex flex-col gap-3">
          <h3 className="font-semibold">New portfolio</h3>
          <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} /></label>
          <div className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Owner</span>
            {owner ? <span className="badge w-fit">{cname(owner)} <button type="button" aria-label="Clear owner" onClick={() => setOwner(null)}>&times;</button></span> : <input className="input" placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />}
            {found.length > 0 && <ul className="flex flex-col gap-1">{found.map((c) => <li key={c.id}><button type="button" className="btn-ghost w-full text-left" onClick={() => { setOwner(c); setFound([]); }}>{cname(c)} <span className="muted text-xs">{[c.phoneE164, c.email].filter(Boolean).join(" / ")}</span></button></li>)}</ul>}
          </div>
          <button className="btn w-fit" disabled={busy}>Create portfolio</button>
        </form>
        <form onSubmit={assign} className="grid gap-3 sm:grid-cols-2">
          <h3 className="font-semibold sm:col-span-2">Assign a unit</h3>
          <label className="flex flex-col gap-1.5 text-sm sm:col-span-2"><span className="muted text-xs font-medium">Unit</span><select className="input" value={o.unitId} onChange={(e) => setO({ ...o, unitId: e.target.value })} required><option value="">Choose</option>{units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</select></label>
          <label className="flex flex-col gap-1.5 text-sm sm:col-span-2"><span className="muted text-xs font-medium">Portfolio</span><select className="input" value={o.portfolioId} onChange={(e) => setO({ ...o, portfolioId: e.target.value })} required><option value="">Choose</option>{portfolios.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
          <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Owner share %</span><input className="input" inputMode="decimal" value={o.sharePct} onChange={(e) => setO({ ...o, sharePct: e.target.value })} /></label>
          <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">From</span><input className="input" type="date" value={o.fromDate} onChange={(e) => setO({ ...o, fromDate: e.target.value })} required /></label>
          <button className="btn w-fit" disabled={busy}>Assign unit</button>
        </form>
      </div>
      {msg && <p role="status" className="mt-3 text-sm">{msg}</p>}
    </details>
  );
}
