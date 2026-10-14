"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Contact = { id: string; firstName?: string | null; lastName?: string | null; companyName?: string | null; email?: string | null; phoneE164?: string | null };
type Opt = { id?: string; code?: string; name: string };
const label = (c: Contact) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.phoneE164 || "Unnamed";
const empty = { stageId: "", assignedUserId: "", campaign: "", isHot: false, firstName: "", lastName: "", phone: "", email: "", contactLanguage: "en", nationality: "", purpose: "buy", sourceCode: "walk_in", projectId: "", budgetMin: "", budgetMax: "", currency: "AED", bedrooms: "", areas: "", language: "en" };

export function NewLeadDrawer({ sources, projects, canReadContacts, stages, users, campaigns, meId }: { sources: Opt[]; projects: Opt[]; canReadContacts: boolean; stages: Opt[]; users: { id: string; email: string }[]; campaigns: string[]; meId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [f, setF] = useState(empty);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Contact[]>([]);
  const [picked, setPicked] = useState<Contact | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const defaultOwner = users.length === 1 ? users[0]!.id : "";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    first.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (mode !== "existing" || q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/v1/contacts?q=${encodeURIComponent(q.trim())}&limit=8&offset=0`);
        const j = await r.json();
        setFound(r.ok ? (j.contacts ?? j.data?.contacts ?? []) : []);
      } catch { setFound([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const lead: Record<string, unknown> = { purpose: f.purpose, sourceCode: f.sourceCode, currency: f.currency, language: f.language, isHot: f.isHot };
    if (f.stageId) lead.stageId = f.stageId;
    if (f.campaign.trim()) lead.campaign = f.campaign.trim();
    if (f.assignedUserId || defaultOwner) lead.assignedUserId = f.assignedUserId || defaultOwner;
    if (f.projectId) lead.projectId = f.projectId;
    if (f.budgetMin) lead.budgetMin = Number(f.budgetMin);
    if (f.budgetMax) lead.budgetMax = Number(f.budgetMax);
    if (f.bedrooms) lead.bedrooms = Number(f.bedrooms);
    const areas = f.areas.split(",").map((a) => a.trim()).filter(Boolean);
    if (areas.length) lead.preferredAreas = areas;
    if (f.budgetMin && f.budgetMax && Number(f.budgetMin) > Number(f.budgetMax)) return setMsg({ ok: false, text: "Minimum budget is above the maximum." });
    if (mode === "existing") {
      if (!picked) return setMsg({ ok: false, text: "Choose a contact to attach." });
      lead.contactId = picked.id;
    } else {
      const contact = Object.fromEntries(Object.entries({ firstName: f.firstName, lastName: f.lastName, phone: f.phone, email: f.email, language: f.contactLanguage, nationality: f.nationality }).filter(([, v]) => v.trim()));
      if (!f.firstName.trim() && !f.phone.trim() && !f.email.trim()) return setMsg({ ok: false, text: "Enter a name, phone or email for the contact." });
      lead.contact = contact;
    }
    setBusy(true);
    const r = await postJson("/api/v1/leads", lead);
    setBusy(false);
    if (!r.ok) return setMsg({ text: errMsg(r), ok: false });
    const d = r.data;
    setMsg({ ok: true, text: d.duplicate ? "Repeat enquiry: added to the existing open lead." : `Lead created${d.contactReused ? " and attached to the existing contact" : ""}${d.assignedUserId ? ", routed to an agent." : " (no agent was eligible, so it is unassigned)."}` });
    setF(empty); setPicked(null); setQ("");
    router.refresh();
  }

  const Field = ({ title, children, span }: { title: string; children: React.ReactNode; span?: boolean }) => (
    <label className={`flex flex-col gap-1.5 ${span ? "sm:col-span-2" : ""}`}><span className="text-xs font-medium muted">{title}</span>{children}</label>
  );
  const Section = ({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) => (
    <section className="rounded-xl border p-5" style={{ borderColor: "var(--border)" }}>
      <header className="mb-4 flex items-center gap-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: "var(--accent)" }}>{n}</span>
        <div><h3 className="font-semibold leading-tight">{title}</h3>{hint && <p className="muted text-xs">{hint}</p>}</div>
      </header>
      {children}
    </section>
  );
  const initials = (c: Contact) => label(c).split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");

  return (
    <>
      <button className="btn" onClick={() => { setOpen(true); setMsg(null); }}>+ Add lead</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Add lead">
          <style>{`@keyframes drawer-in{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}@media (prefers-reduced-motion:no-preference){.drawer-panel{animation:drawer-in .18s ease-out}}`}</style>
          <button className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={submit} className="drawer-panel relative flex h-full w-full max-w-3xl flex-col shadow-2xl" style={{ background: "var(--bg, var(--card))" }}>
            <header className="flex items-start justify-between gap-4 border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <div><h2 className="text-xl font-semibold">Add lead</h2><p className="muted text-sm">Capture the contact, then say where the lead came from and who owns it.</p></div>
              <button type="button" ref={first} className="btn-ghost text-sm" onClick={() => setOpen(false)} aria-label="Close drawer">&#10005;</button>
            </header>

            <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
              <Section n={1} title="Contact" hint="Who is enquiring? Matching email or phone reuses the existing contact.">
                <div className="mb-4 inline-flex rounded-lg border p-0.5 text-sm" style={{ borderColor: "var(--border)" }} role="tablist">
                  <button type="button" role="tab" aria-selected={mode === "new"} className={`rounded-md px-3 py-1.5 ${mode === "new" ? "btn" : ""}`} onClick={() => setMode("new")}>New contact</button>
                  {canReadContacts && <button type="button" role="tab" aria-selected={mode === "existing"} className={`rounded-md px-3 py-1.5 ${mode === "existing" ? "btn" : ""}`} onClick={() => setMode("existing")}>Existing contact</button>}
                </div>
                {mode === "new" ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field title="First name"><input className="input" value={f.firstName} onChange={set("firstName")} autoComplete="off" /></Field>
                    <Field title="Last name"><input className="input" value={f.lastName} onChange={set("lastName")} autoComplete="off" /></Field>
                    <Field title="Phone"><input className="input" inputMode="tel" placeholder="+971 50 123 4567" value={f.phone} onChange={set("phone")} autoComplete="off" /></Field>
                    <Field title="Email"><input className="input" type="email" placeholder="name@example.com" value={f.email} onChange={set("email")} autoComplete="off" /></Field>
                    <Field title="Nationality"><input className="input" value={f.nationality} onChange={set("nationality")} /></Field>
                    <Field title="Contact language"><select className="input" value={f.contactLanguage} onChange={set("contactLanguage")}><option value="en">English</option><option value="ar">Arabic</option></select></Field>
                  </div>
                ) : picked ? (
                  <div className="flex items-center justify-between rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: "var(--accent)" }}>{initials(picked)}</span>
                      <div><p className="font-medium">{label(picked)}</p><p className="muted text-xs">{[picked.email, picked.phoneE164].filter(Boolean).join(" - ")}</p></div>
                    </div>
                    <button type="button" className="btn-ghost text-xs" onClick={() => setPicked(null)}>Change</button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <input className="input" placeholder="Search by name, email or phone (2+ characters)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" autoComplete="off" autoFocus />
                    <ul className="flex flex-col gap-1 text-sm">
                      {found.map((c) => (
                        <li key={c.id}><button type="button" className="flex w-full items-center gap-3 rounded-lg border p-2.5 text-left hover:opacity-80" style={{ borderColor: "var(--border)" }} onClick={() => setPicked(c)}>
                          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/10 text-xs font-bold">{initials(c)}</span>
                          <span>{label(c)}<br /><span className="muted text-xs">{[c.email, c.phoneE164].filter(Boolean).join(" - ")}</span></span>
                        </button></li>
                      ))}
                      {q.trim().length >= 2 && found.length === 0 && <li className="muted p-2">No matching contacts. Use "New contact" to create one.</li>}
                    </ul>
                  </div>
                )}
              </Section>

              <Section n={2} title="Lead" hint="Status, origin and ownership.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field title="Lead status"><select className="input" value={f.stageId} onChange={set("stageId")}><option value="">{stages[0]?.name ?? "New"}</option>{stages.slice(1).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
                  <Field title="Source"><select className="input" value={f.sourceCode} onChange={set("sourceCode")}>{sources.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></Field>
                  <Field title="Campaign"><input className="input" list="lead-campaigns" value={f.campaign} onChange={set("campaign")} placeholder="e.g. Instagram Ramadan" /><datalist id="lead-campaigns">{campaigns.map((c) => <option key={c} value={c} />)}</datalist></Field>
                  <Field title="Assign to">
                    <select className="input" value={f.assignedUserId || defaultOwner} onChange={set("assignedUserId")} disabled={users.length === 1}>
                      {users.length !== 1 && <option value="">Auto-assign (routing rules)</option>}
                      {users.map((u) => <option key={u.id} value={u.id}>{u.email}{u.id === meId ? " (me)" : ""}</option>)}
                    </select>
                  </Field>
                  <div className="sm:col-span-2">
                    <button type="button" role="switch" aria-checked={f.isHot} onClick={() => setF({ ...f, isHot: !f.isHot })} className="flex w-full items-center justify-between rounded-lg border p-3 text-left" style={{ borderColor: f.isHot ? "var(--accent)" : "var(--border)" }}>
                      <span><span className="font-medium">&#9650; Hot lead</span><br /><span className="muted text-xs">Flag for a fast response; shown first in the list.</span></span>
                      <span className="relative inline-block h-6 w-11 rounded-full" style={{ background: f.isHot ? "var(--accent)" : "rgba(128,128,128,.4)" }}><span className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" style={{ left: f.isHot ? "1.375rem" : "0.125rem" }} /></span>
                    </button>
                  </div>
                </div>
              </Section>

              <details className="rounded-xl border" style={{ borderColor: "var(--border)" }}>
                <summary className="cursor-pointer px-5 py-4 font-semibold">Requirements <span className="muted text-xs font-normal">(optional: purpose, budget, project, areas)</span></summary>
                <div className="grid gap-4 border-t p-5 sm:grid-cols-2" style={{ borderColor: "var(--border)" }}>
                  <Field title="Purpose"><select className="input" value={f.purpose} onChange={set("purpose")}><option value="buy">Buy</option><option value="rent">Rent</option><option value="invest">Invest</option><option value="off_plan">Off-plan</option></select></Field>
                  <Field title="Lead language"><select className="input" value={f.language} onChange={set("language")}><option value="en">English</option><option value="ar">Arabic</option></select></Field>
                  <Field title="Project" span><select className="input" value={f.projectId} onChange={set("projectId")}><option value="">None</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
                  <Field title="Budget min"><input className="input" type="number" min="0" value={f.budgetMin} onChange={set("budgetMin")} /></Field>
                  <Field title="Budget max"><input className="input" type="number" min="0" value={f.budgetMax} onChange={set("budgetMax")} /></Field>
                  <Field title="Currency"><select className="input" value={f.currency} onChange={set("currency")}><option>AED</option><option>USD</option><option>EUR</option><option>GBP</option></select></Field>
                  <Field title="Bedrooms"><input className="input" type="number" min="0" max="20" value={f.bedrooms} onChange={set("bedrooms")} /></Field>
                  <Field title="Preferred areas (comma separated)" span><input className="input" value={f.areas} onChange={set("areas")} placeholder="Dubai Marina, Downtown" /></Field>
                </div>
              </details>
            </div>

            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role={msg?.ok ? "status" : "alert"} className={`min-w-0 flex-1 text-sm ${msg?.ok ? "muted" : "err"}`}>{msg?.text}</p>
              <div className="flex shrink-0 gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Close</button><button className="btn" disabled={busy}>{busy ? "Saving..." : "Add lead"}</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}
