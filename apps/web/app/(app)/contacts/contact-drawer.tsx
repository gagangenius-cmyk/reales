"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export interface ContactValues {
  firstName?: string; lastName?: string; companyName?: string; email?: string; phone?: string; language?: string; nationality?: string; salutation?: string; gender?: string; dateOfBirth?: string;
  jobTitle?: string; employer?: string; phoneSecondary?: string; whatsapp?: string; addressLine?: string; city?: string; country?: string; residency?: string;
  preferredChannel?: string; preferredContactTime?: string; tags?: string; notes?: string;
}
const KEYS = ["firstName", "lastName", "companyName", "email", "phone", "language", "nationality", "salutation", "gender", "dateOfBirth", "jobTitle", "employer", "phoneSecondary", "whatsapp", "addressLine", "city", "country", "residency", "preferredChannel", "preferredContactTime", "notes"] as const;

/** Create (no id) or edit (id given) a contact. Empty fields are not sent on create; on edit they are sent so a value can be cleared. */
export function ContactDrawer({ id, initial = {}, label }: { id?: string; initial?: ContactValues; label?: string }) {
  const router = useRouter();
  const edit = !!id;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Required<ContactValues>>({ ...Object.fromEntries(KEYS.map((k) => [k, initial[k] ?? ""])), language: initial.language ?? "en", tags: initial.tags ?? "" } as Required<ContactValues>);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof ContactValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!edit && !f.firstName.trim() && !f.lastName.trim() && !f.companyName.trim() && !f.phone.trim() && !f.email.trim()) return setMsg("Enter a name, company, phone or email.");
    const body: Record<string, unknown> = {};
    for (const k of KEYS) {
      const v = (f[k] ?? "").trim();
      if (edit && !["email", "phone", "phoneSecondary", "whatsapp", "language"].includes(k)) { if (v !== (initial[k] ?? "")) body[k] = v || null; }
      else if (v) body[k] = v;
    }
    if (edit) for (const k of ["email", "phone", "phoneSecondary", "whatsapp"] as const) if ((initial[k] ?? "") !== (f[k] ?? "").trim()) body[k] = (f[k] ?? "").trim();
    const tags = f.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.length || (edit && initial.tags)) body.tags = tags;
    setBusy(true);
    const r = await postJson(edit ? `/api/v1/contacts/${id}` : "/api/v1/contacts", body, edit ? "PATCH" : "POST");
    setBusy(false);
    if (r.status === 409 && r.data?.error?.code === "duplicate_contact") {
      const m = r.data.error;
      return setMsg(m.matches?.length ? `Already exists: ${m.matches.map((x: any) => x.name).join(", ")}` : `A contact with this phone or email already exists (${m.matchCount}).`);
    }
    if (!r.ok) return setMsg(errMsg(r));
    setOpen(false);
    router.refresh();
  }

  const Lab = ({ t, children, span }: { t: string; children: React.ReactNode; span?: boolean }) => <label className={`flex flex-col gap-1.5 text-sm ${span ? "sm:col-span-2" : ""}`}><span className="muted text-xs font-medium">{t}</span>{children}</label>;
  return (
    <>
      <button className={edit ? "btn-ghost text-sm" : "btn"} onClick={() => { setOpen(true); setMsg(null); }}>{label ?? (edit ? "Edit" : "+ Add contact")}</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={edit ? "Edit contact" : "Add contact"}>
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={submit} className="relative flex h-full w-full max-w-3xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-xl font-semibold">{edit ? "Edit contact" : "Add contact"}</h2><p className="muted text-sm">A matching phone or email is never duplicated.</p></header>
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-6">
              <section className="card grid gap-4 p-4 sm:grid-cols-2">
                <h3 className="font-semibold sm:col-span-2">Identity</h3>
                <Lab t="Salutation"><select className="input" value={f.salutation} onChange={set("salutation")}><option value="">-</option>{["Mr", "Mrs", "Ms", "Dr", "Eng", "Sheikh", "Sheikha"].map((x) => <option key={x}>{x}</option>)}</select></Lab>
                <Lab t="Gender"><select className="input" value={f.gender} onChange={set("gender")}><option value="">-</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></Lab>
                <Lab t="First name"><input className="input" value={f.firstName} onChange={set("firstName")} /></Lab>
                <Lab t="Last name"><input className="input" value={f.lastName} onChange={set("lastName")} /></Lab>
                <Lab t="Company (for company contacts)" span><input className="input" value={f.companyName} onChange={set("companyName")} /></Lab>
                <Lab t="Date of birth"><input className="input" type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} /></Lab>
                <Lab t="Nationality"><input className="input" value={f.nationality} onChange={set("nationality")} /></Lab>
                <Lab t="UAE residency"><select className="input" value={f.residency} onChange={set("residency")}><option value="">-</option><option value="uae_resident">UAE resident</option><option value="non_resident">Non-resident</option></select></Lab>
                <Lab t="Language"><select className="input" value={f.language} onChange={set("language")}><option value="en">English</option><option value="ar">Arabic</option></select></Lab>
              </section>
              <section className="card grid gap-4 p-4 sm:grid-cols-2">
                <h3 className="font-semibold sm:col-span-2">Reaching them</h3>
                <Lab t="Phone"><input className="input" inputMode="tel" placeholder="+971 50 123 4567" value={f.phone} onChange={set("phone")} /></Lab>
                <Lab t="Second phone"><input className="input" inputMode="tel" value={f.phoneSecondary} onChange={set("phoneSecondary")} /></Lab>
                <Lab t="WhatsApp (if different)"><input className="input" inputMode="tel" value={f.whatsapp} onChange={set("whatsapp")} /></Lab>
                <Lab t="Email"><input className="input" type="email" value={f.email} onChange={set("email")} /></Lab>
                <Lab t="Prefers to be contacted by"><select className="input" value={f.preferredChannel} onChange={set("preferredChannel")}><option value="">No preference</option><option value="phone">Phone call</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="sms">SMS</option></select></Lab>
                <Lab t="Best time to reach"><input className="input" value={f.preferredContactTime} onChange={set("preferredContactTime")} placeholder="Weekdays after 6pm" /></Lab>
              </section>
              <section className="card grid gap-4 p-4 sm:grid-cols-2">
                <h3 className="font-semibold sm:col-span-2">Work and address</h3>
                <Lab t="Job title"><input className="input" value={f.jobTitle} onChange={set("jobTitle")} /></Lab>
                <Lab t="Employer"><input className="input" value={f.employer} onChange={set("employer")} /></Lab>
                <Lab t="Address" span><input className="input" value={f.addressLine} onChange={set("addressLine")} /></Lab>
                <Lab t="City"><input className="input" value={f.city} onChange={set("city")} /></Lab>
                <Lab t="Country"><input className="input" value={f.country} onChange={set("country")} /></Lab>
              </section>
              <section className="card grid gap-4 p-4">
                <h3 className="font-semibold">Notes</h3>
                <Lab t="Tags (comma separated)"><input className="input" value={f.tags} onChange={set("tags")} placeholder="investor, golden-visa" /></Lab>
                <Lab t="Notes"><textarea className="input min-h-24" maxLength={5000} value={f.notes} onChange={set("notes")} /></Lab>
              </section>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p>
              <div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving..." : edit ? "Save" : "Add contact"}</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}
