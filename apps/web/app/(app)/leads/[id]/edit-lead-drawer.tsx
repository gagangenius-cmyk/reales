"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export interface LeadValues {
  purpose: string; budgetMin: string; budgetMax: string; currency: string; bedrooms: string; preferredAreas: string; language: string; isHot: boolean; campaign: string;
  financing: string; purchaseTimeline: string; propertyTypes: string[]; tags: string; notes: string; nextFollowUpAt: string; expectedCloseDate: string;
}

const Lab = ({ t, children, span }: { t: string; children: React.ReactNode; span?: boolean }) => <label className={`flex flex-col gap-1.5 text-sm ${span ? "sm:col-span-2" : ""}`}><span className="muted text-xs font-medium">{t}</span>{children}</label>;

export function EditLeadDrawer({ leadId, initial }: { leadId: string; initial: LeadValues }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof LeadValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (f.budgetMin && f.budgetMax && Number(f.budgetMin) > Number(f.budgetMax)) return setMsg("Minimum budget is above the maximum.");
    const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    const body: Record<string, unknown> = { purpose: f.purpose, currency: f.currency, language: f.language, isHot: f.isHot, propertyTypes: f.propertyTypes, preferredAreas: list(f.preferredAreas), tags: list(f.tags), notes: f.notes };
    if (f.budgetMin) body.budgetMin = Number(f.budgetMin);
    if (f.budgetMax) body.budgetMax = Number(f.budgetMax);
    if (f.bedrooms) body.bedrooms = Number(f.bedrooms);
    if (f.campaign.trim()) body.campaign = f.campaign.trim();
    if (f.financing) body.financing = f.financing;
    if (f.purchaseTimeline) body.purchaseTimeline = f.purchaseTimeline;
    if (f.nextFollowUpAt) body.nextFollowUpAt = new Date(`${f.nextFollowUpAt}:00+04:00`).toISOString();
    if (f.expectedCloseDate) body.expectedCloseDate = f.expectedCloseDate;
    setBusy(true);
    const r = await postJson(`/api/v1/leads/${leadId}`, body, "PATCH");
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r));
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button className="btn-ghost" onClick={() => { setOpen(true); setMsg(null); }}>Edit lead</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Edit lead">
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={submit} className="relative flex h-full w-full max-w-3xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-xl font-semibold">Edit lead</h2><p className="muted text-sm">Stage and owner are changed from the lead page actions, so they stay in the history.</p></header>
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-6">
              <section className="card grid gap-4 p-4 sm:grid-cols-2">
                <h3 className="font-semibold sm:col-span-2">Enquiry</h3>
                <Lab t="Purpose"><select className="input" value={f.purpose} onChange={set("purpose")}><option value="buy">Buy</option><option value="rent">Rent</option><option value="invest">Invest</option><option value="off_plan">Off-plan</option></select></Lab>
                <Lab t="Language"><select className="input" value={f.language} onChange={set("language")}><option value="en">English</option><option value="ar">Arabic</option></select></Lab>
                <Lab t="Budget min"><input className="input" type="number" min="0" value={f.budgetMin} onChange={set("budgetMin")} /></Lab>
                <Lab t="Budget max"><input className="input" type="number" min="0" value={f.budgetMax} onChange={set("budgetMax")} /></Lab>
                <Lab t="Currency"><select className="input" value={f.currency} onChange={set("currency")}><option>AED</option><option>USD</option><option>EUR</option><option>GBP</option></select></Lab>
                <Lab t="Bedrooms"><input className="input" type="number" min="0" max="20" value={f.bedrooms} onChange={set("bedrooms")} /></Lab>
                <Lab t="Preferred areas (comma separated)" span><input className="input" value={f.preferredAreas} onChange={set("preferredAreas")} /></Lab>
                <div className="sm:col-span-2"><span className="muted text-xs font-medium">Property types</span><div className="mt-1.5 flex flex-wrap gap-2">{["apartment", "villa", "townhouse", "penthouse", "office", "retail", "land"].map((t) => <button key={t} type="button" className={f.propertyTypes.includes(t) ? "btn text-xs" : "btn-ghost text-xs"} onClick={() => setF({ ...f, propertyTypes: f.propertyTypes.includes(t) ? f.propertyTypes.filter((x) => x !== t) : [...f.propertyTypes, t] })}>{t}</button>)}</div></div>
                <Lab t="Financing"><select className="input" value={f.financing} onChange={set("financing")}><option value="">Not known</option><option value="cash">Cash</option><option value="mortgage">Mortgage</option><option value="undecided">Undecided</option></select></Lab>
                <Lab t="Looking to move"><select className="input" value={f.purchaseTimeline} onChange={set("purchaseTimeline")}><option value="">Not known</option><option value="immediate">Immediately</option><option value="one_to_three_months">In 1-3 months</option><option value="three_to_six_months">In 3-6 months</option><option value="over_six_months">After 6 months</option><option value="exploring">Just exploring</option></select></Lab>
              </section>
              <section className="card grid gap-4 p-4 sm:grid-cols-2">
                <h3 className="font-semibold sm:col-span-2">Follow-up and tracking</h3>
                <Lab t="Campaign"><input className="input" value={f.campaign} onChange={set("campaign")} /></Lab>
                <Lab t="Next follow-up (Dubai time)"><input className="input" type="datetime-local" value={f.nextFollowUpAt} onChange={set("nextFollowUpAt")} /></Lab>
                <Lab t="Expected close date"><input className="input" type="date" value={f.expectedCloseDate} onChange={set("expectedCloseDate")} /></Lab>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isHot} onChange={(e) => setF({ ...f, isHot: e.target.checked })} /> Hot lead</label>
                <Lab t="Tags (comma separated)" span><input className="input" value={f.tags} onChange={set("tags")} /></Lab>
                <Lab t="Notes" span><textarea className="input min-h-24" maxLength={5000} value={f.notes} onChange={set("notes")} /></Lab>
              </section>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p>
              <div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving..." : "Save"}</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}
