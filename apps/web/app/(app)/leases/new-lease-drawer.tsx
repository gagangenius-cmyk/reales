"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type UnitOpt = { id: string; label: string };
type Contact = { id: string; firstName?: string | null; lastName?: string | null; companyName?: string | null; phoneE164?: string | null; email?: string | null };
const cname = (c: Contact) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.phoneE164 || "Contact";

/** Create a lease: pick the unit, the tenant(s), the term and rent; the server builds the rent schedule and checks the unit has no overlapping active lease. */
export function NewLeaseDrawer({ units }: { units: UnitOpt[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ unitId: "", startsOn: "", endsOn: "", annualRent: "", installments: "4", deposit: "", registrationRef: "" });
  const [tenants, setTenants] = useState<Contact[]>([]);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Contact[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false); document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [open]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(async () => { try { const r = await fetch(`/api/v1/contacts?q=${encodeURIComponent(q.trim())}&limit=6&offset=0`); const j = await r.json(); setFound(r.ok ? j.contacts ?? [] : []); } catch { setFound([]); } }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    if (!f.unitId) return setMsg("Choose the unit.");
    if (!tenants.length) return setMsg("Add at least one tenant.");
    const rent = Number(f.annualRent);
    if (!(rent > 0)) return setMsg("Enter the annual rent.");
    const body: Record<string, unknown> = { unitId: f.unitId, startsOn: f.startsOn, endsOn: f.endsOn, annualRent: rent, installments: Number(f.installments) || 1, tenantContactIds: tenants.map((t) => t.id) };
    if (f.deposit) body.depositAmount = Number(f.deposit);
    if (f.registrationRef.trim()) body.registrationRef = f.registrationRef.trim();
    setBusy(true);
    const r = await postJson("/api/v1/leases", body);
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r));
    setOpen(false); setTenants([]); setF({ unitId: "", startsOn: "", endsOn: "", annualRent: "", installments: "4", deposit: "", registrationRef: "" });
    router.refresh();
  }

  const Lab = ({ t, children, span }: { t: string; children: React.ReactNode; span?: boolean }) => <label className={`flex flex-col gap-1.5 text-sm ${span ? "sm:col-span-2" : ""}`}><span className="muted text-xs font-medium">{t}</span>{children}</label>;
  return (
    <>
      <button className="btn" onClick={() => { setOpen(true); setMsg(null); }}>+ New lease</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="New lease">
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={submit} className="relative flex h-full w-full max-w-2xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-xl font-semibold">New lease</h2><p className="muted text-sm">The rent schedule is created from the annual rent and the number of instalments.</p></header>
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-6">
              <section className="card grid gap-4 p-4 sm:grid-cols-2">
                <Lab t="Unit" span><select className="input" value={f.unitId} onChange={set("unitId")} required><option value="">Choose a unit</option>{units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</select></Lab>
                <Lab t="Starts on"><input className="input" type="date" value={f.startsOn} onChange={set("startsOn")} required /></Lab>
                <Lab t="Ends on"><input className="input" type="date" value={f.endsOn} onChange={set("endsOn")} required /></Lab>
                <Lab t="Annual rent (AED)"><input className="input" inputMode="decimal" value={f.annualRent} onChange={set("annualRent")} required /></Lab>
                <Lab t="Cheques / instalments"><select className="input" value={f.installments} onChange={set("installments")}>{[1, 2, 3, 4, 6, 12].map((n) => <option key={n} value={n}>{n}</option>)}</select></Lab>
                <Lab t="Security deposit (AED)"><input className="input" inputMode="decimal" value={f.deposit} onChange={set("deposit")} /></Lab>
                <Lab t="Ejari / registration reference"><input className="input" value={f.registrationRef} onChange={set("registrationRef")} /></Lab>
              </section>
              <section className="card flex flex-col gap-3 p-4">
                <h3 className="font-semibold">Tenants</h3>
                {tenants.length > 0 && <ul className="flex flex-wrap gap-2">{tenants.map((t) => <li key={t.id} className="badge">{cname(t)} <button type="button" aria-label={`Remove ${cname(t)}`} onClick={() => setTenants(tenants.filter((x) => x.id !== t.id))}>&times;</button></li>)}</ul>}
                <input className="input" placeholder="Search contacts by name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} />
                {found.length > 0 && <ul className="flex flex-col gap-1 text-sm">{found.filter((c) => !tenants.some((t) => t.id === c.id)).map((c) => <li key={c.id}><button type="button" className="btn-ghost w-full text-left" onClick={() => { if (tenants.length < 6) setTenants([...tenants, c]); setQ(""); setFound([]); }}>{cname(c)} <span className="muted text-xs">{[c.phoneE164, c.email].filter(Boolean).join(" / ")}</span></button></li>)}</ul>}
              </section>
              {msg && <p role="alert" className="text-sm" style={{ color: "var(--danger, #b91c1c)" }}>{msg}</p>}
            </div>
            <footer className="flex justify-end gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving..." : "Create lease"}</button></footer>
          </form>
        </div>
      )}
    </>
  );
}
