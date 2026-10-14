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

  return (
    <>
      <button className="btn" onClick={() => { setOpen(true); setMsg(null); }}>+ Add lead</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Add lead">
          <button className="absolute inset-0 bg-black/40" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={submit} className="relative flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto p-5 shadow-xl" style={{ background: "var(--card)" }}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Add lead</h2>
              <button type="button" ref={first} className="btn-ghost text-sm" onClick={() => setOpen(false)}>Close</button>
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 font-semibold">Contact</legend>
              <div className="flex gap-2 text-sm">
                <button type="button" className={mode === "new" ? "btn" : "btn-ghost"} onClick={() => setMode("new")}>New contact</button>
                {canReadContacts && <button type="button" className={mode === "existing" ? "btn" : "btn-ghost"} onClick={() => setMode("existing")}>Existing contact</button>}
              </div>
              {mode === "new" ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <input className="input" placeholder="First name" value={f.firstName} onChange={set("firstName")} aria-label="First name" />
                    <input className="input" placeholder="Last name" value={f.lastName} onChange={set("lastName")} aria-label="Last name" />
                    <input className="input" placeholder="Phone (+971...)" value={f.phone} onChange={set("phone")} aria-label="Phone" />
                    <input className="input" type="email" placeholder="Email" value={f.email} onChange={set("email")} aria-label="Email" />
                    <input className="input" placeholder="Nationality" value={f.nationality} onChange={set("nationality")} aria-label="Nationality" />
                    <select className="input" value={f.contactLanguage} onChange={set("contactLanguage")} aria-label="Contact language"><option value="en">English</option><option value="ar">Arabic</option></select>
                  </div>
                  <p className="muted text-xs">If the email or phone already belongs to a contact, that contact is reused instead of creating a duplicate.</p>
                </>
              ) : picked ? (
                <div className="card flex items-center justify-between p-3 text-sm">
                  <span>{label(picked)}<br /><span className="muted text-xs">{picked.email ?? picked.phoneE164 ?? ""}</span></span>
                  <button type="button" className="btn-ghost text-xs" onClick={() => setPicked(null)}>Change</button>
                </div>
              ) : (
                <>
                  <input className="input" placeholder="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" autoComplete="off" />
                  <ul className="flex flex-col gap-1 text-sm">
                    {found.map((c) => <li key={c.id}><button type="button" className="btn-ghost w-full text-left" onClick={() => setPicked(c)}>{label(c)} <span className="muted text-xs">{c.email ?? c.phoneE164 ?? ""}</span></button></li>)}
                    {q.trim().length >= 2 && found.length === 0 && <li className="muted">No matching contacts.</li>}
                  </ul>
                </>
              )}
            </fieldset>

            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 font-semibold">Lead</legend>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm">Lead status<select className="input mt-1" value={f.stageId} onChange={set("stageId")}><option value="">{stages[0]?.name ?? "New"} (default)</option>{stages.slice(1).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                <label className="text-sm">Source<select className="input mt-1" value={f.sourceCode} onChange={set("sourceCode")}>{sources.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
                <label className="text-sm">Campaign<input className="input mt-1" list="lead-campaigns" value={f.campaign} onChange={set("campaign")} placeholder="e.g. Instagram Ramadan" /><datalist id="lead-campaigns">{campaigns.map((c) => <option key={c} value={c} />)}</datalist></label>
                <label className="text-sm">Assign to
                  <select className="input mt-1" value={f.assignedUserId || defaultOwner} onChange={set("assignedUserId")} disabled={users.length === 1}>
                    {users.length !== 1 && <option value="">Auto-assign (routing rules)</option>}
                    {users.map((u) => <option key={u.id} value={u.id}>{u.email}{u.id === meId ? " (me)" : ""}</option>)}
                  </select>
                </label>
                <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isHot} onChange={(e) => setF({ ...f, isHot: e.target.checked })} /> Hot lead (needs a fast response)</label>
              </div>
              <details>
                <summary className="cursor-pointer text-sm font-semibold">More details (purpose, budget, project, areas)</summary>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="text-sm">Purpose<select className="input mt-1" value={f.purpose} onChange={set("purpose")}><option value="buy">Buy</option><option value="rent">Rent</option><option value="invest">Invest</option><option value="off_plan">Off-plan</option></select></label>
                  <label className="text-sm">Language<select className="input mt-1" value={f.language} onChange={set("language")}><option value="en">English</option><option value="ar">Arabic</option></select></label>
                  <label className="col-span-2 text-sm">Project (optional)<select className="input mt-1" value={f.projectId} onChange={set("projectId")}><option value="">None</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                  <label className="text-sm">Budget min<input className="input mt-1" type="number" min="0" value={f.budgetMin} onChange={set("budgetMin")} /></label>
                  <label className="text-sm">Budget max<input className="input mt-1" type="number" min="0" value={f.budgetMax} onChange={set("budgetMax")} /></label>
                  <label className="text-sm">Currency<select className="input mt-1" value={f.currency} onChange={set("currency")}><option>AED</option><option>USD</option><option>EUR</option><option>GBP</option></select></label>
                  <label className="text-sm">Bedrooms<input className="input mt-1" type="number" min="0" max="20" value={f.bedrooms} onChange={set("bedrooms")} /></label>
                  <label className="col-span-2 text-sm">Preferred areas (comma separated)<input className="input mt-1" value={f.areas} onChange={set("areas")} placeholder="Dubai Marina, Downtown" /></label>
                </div>
              </details>
            </fieldset>

            {msg && <p role={msg.ok ? "status" : "alert"} className={`${msg.ok ? "muted" : "err"} text-sm`}>{msg.text}</p>}
            <div className="mt-auto flex gap-2"><button className="btn" disabled={busy}>{busy ? "Saving..." : "Add lead"}</button><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Done</button></div>
          </form>
        </div>
      )}
    </>
  );
}
