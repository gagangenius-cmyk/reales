"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Setup = {
  accounts: { id: string; channel: string; name: string; identity: string; provider: string }[];
  templates: { id: string; versionId: string; name: string; channel: string; subject: string | null; text: string }[];
  segments: { id: string; name: string; definition: Record<string, unknown> }[];
  purposes: { code: string; name: string }[];
};
const STEPS = ["Basics", "Audience", "Message", "Sending", "Review"];
const CH: [string, string][] = [["whatsapp", "WhatsApp"], ["email", "Email"], ["sms", "SMS"]];
const cap = "muted text-xs font-medium";

export function BroadcastWizard({ setup, projects }: { setup: Setup; projects: { id: string; name: string }[] }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("whatsapp");
  const [audMode, setAudMode] = useState<"saved" | "build">(setup.segments.length ? "saved" : "build");
  const [segmentId, setSegmentId] = useState(setup.segments[0]?.id ?? "");
  const [seg, setSeg] = useState({ name: "", languages: "", nationality: "", hasOpenLead: "any", purposes: [] as string[], projectIds: [] as string[], budgetMin: "", budgetMax: "", createdAfter: "", createdBefore: "" });
  const [count, setCount] = useState<number | null>(null);
  const [versionId, setVersionId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [purposeCode, setPurposeCode] = useState(setup.purposes.find((p) => /market/i.test(p.code))?.code ?? setup.purposes[0]?.code ?? "");
  const [rate, setRate] = useState("60");
  const [when, setWhen] = useState<"draft" | "now" | "later">("draft");
  const [at, setAt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const templates = setup.templates.filter((t) => t.channel === channel);
  const accounts = setup.accounts.filter((a) => a.channel === channel);
  const tpl = templates.find((t) => t.versionId === versionId);
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const def = useMemo(() => {
    const d: Record<string, unknown> = {};
    const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    if (list(seg.languages).length) d.language = list(seg.languages);
    if (list(seg.nationality).length) d.nationality = list(seg.nationality);
    if (seg.hasOpenLead !== "any") d.hasOpenLead = seg.hasOpenLead === "yes";
    if (seg.purposes.length) d.leadPurpose = seg.purposes;
    if (seg.projectIds.length) d.leadProjectIds = seg.projectIds;
    if (seg.budgetMin) d.budgetMin = Number(seg.budgetMin);
    if (seg.budgetMax) d.budgetMax = Number(seg.budgetMax);
    if (seg.createdAfter) d.createdAfter = new Date(`${seg.createdAfter}T00:00:00+04:00`).toISOString();
    if (seg.createdBefore) d.createdBefore = new Date(`${seg.createdBefore}T00:00:00+04:00`).toISOString();
    return d;
  }, [seg]);
  const chosenDef = audMode === "saved" ? setup.segments.find((s) => s.id === segmentId)?.definition ?? {} : def;

  useEffect(() => {
    if (step !== 1) return;
    setCount(null);
    const t = setTimeout(async () => {
      const r = await postJson("/api/v1/segments/preview", { definition: chosenDef });
      setCount(r.ok ? r.data.count : null);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, audMode, segmentId, JSON.stringify(def)]);

  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  function validate(s: number): string | null {
    if (s === 0 && !name.trim()) return "Give the broadcast a name.";
    if (s === 1 && audMode === "saved" && !segmentId) return "Choose a saved audience or build a new one.";
    if (s === 1 && audMode === "build" && !seg.name.trim()) return "Name the new audience so you can reuse it.";
    if (s === 2 && !tpl) return templates.length ? "Choose an approved template." : `No approved ${channel} templates. Create and approve one under Templates first.`;
    if (s === 3 && !account) return `No active ${channel} sending account is connected.`;
    if (s === 3 && !purposeCode) return "Choose the consent purpose recipients agreed to.";
    if (s === 3 && when === "later" && !at) return "Pick the date and time to send.";
    return null;
  }
  const next = () => { const e = validate(step); setErr(e); if (!e) setStep(step + 1); };

  async function launch() {
    for (let s = 0; s < 4; s++) { const e = validate(s); if (e) { setStep(s); return setErr(e); } }
    setBusy(true); setErr(null);
    let segId = segmentId;
    if (audMode === "build") {
      const r = await postJson("/api/v1/segments", { name: seg.name.trim(), definition: def });
      if (!r.ok) { setBusy(false); return setErr(errMsg(r)); }
      segId = r.data.id;
    }
    const scheduledAt = when === "later" ? new Date(`${at}:00+04:00`).toISOString() : undefined;
    const c = await postJson("/api/v1/campaigns", { name: name.trim(), channel, templateVersionId: tpl!.versionId, segmentId: segId, channelAccountId: account!.id, purposeCode, maxPerMinute: Number(rate) || 60, ...(scheduledAt && { scheduledAt }) });
    if (!c.ok) { setBusy(false); return setErr(errMsg(c)); }
    if (when !== "draft") {
      const s = await postJson(`/api/v1/campaigns/${c.data.id}/schedule`, scheduledAt ? { at: scheduledAt } : {});
      if (!s.ok) { setBusy(false); return setErr(`Created as a draft, but scheduling failed: ${errMsg(s)}`); }
    }
    router.push(`/campaigns/${c.data.id}`);
  }

  const Lab = ({ t, children, span }: { t: string; children: React.ReactNode; span?: boolean }) => <label className={`flex flex-col gap-1.5 text-sm ${span ? "sm:col-span-2" : ""}`}><span className={cap}>{t}</span>{children}</label>;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s}><button type="button" disabled={i > step} onClick={() => setStep(i)} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${i === step ? "btn" : i < step ? "btn-ghost" : "opacity-60"}`} style={{ borderColor: "var(--border)" }}>
            <span className="font-bold">{i < step ? "✓" : i + 1}</span>{s}
          </button></li>
        ))}
      </ol>

      <div className="card p-6">
        {step === 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Lab t="Broadcast name" span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Marina Heights launch - November" autoFocus /></Lab>
            <div className="sm:col-span-2"><span className={cap}>Channel</span>
              <div className="mt-1.5 grid gap-3 sm:grid-cols-3" role="radiogroup">
                {CH.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={channel === v} onClick={() => { setChannel(v); setVersionId(""); setAccountId(""); }} className="card p-3 text-left" style={{ boxShadow: channel === v ? "0 0 0 2px var(--accent)" : undefined }}><span className="font-semibold">{l}</span><br /><span className="muted text-xs">{setup.templates.filter((t) => t.channel === v).length} approved templates &middot; {setup.accounts.filter((a) => a.channel === v).length} account(s)</span></button>)}
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div className="inline-flex w-fit rounded-lg border p-0.5 text-sm" style={{ borderColor: "var(--border)" }}>
              {setup.segments.length > 0 && <button type="button" className={`rounded-md px-3 py-1.5 ${audMode === "saved" ? "btn" : ""}`} onClick={() => setAudMode("saved")}>Saved audience</button>}
              <button type="button" className={`rounded-md px-3 py-1.5 ${audMode === "build" ? "btn" : ""}`} onClick={() => setAudMode("build")}>Build new</button>
            </div>
            {audMode === "saved" ? (
              <Lab t="Audience"><select className="input" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>{setup.segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Lab>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Lab t="Audience name" span><input className="input" value={seg.name} onChange={(e) => setSeg({ ...seg, name: e.target.value })} placeholder="e.g. Open buyer leads, Arabic speakers" /></Lab>
                <Lab t="Languages (comma separated, e.g. en, ar)"><input className="input" value={seg.languages} onChange={(e) => setSeg({ ...seg, languages: e.target.value })} /></Lab>
                <Lab t="Nationalities (comma separated)"><input className="input" value={seg.nationality} onChange={(e) => setSeg({ ...seg, nationality: e.target.value })} /></Lab>
                <Lab t="Has an open lead"><select className="input" value={seg.hasOpenLead} onChange={(e) => setSeg({ ...seg, hasOpenLead: e.target.value })}><option value="any">Any contact</option><option value="yes">Only with an open lead</option><option value="no">Only without an open lead</option></select></Lab>
                <div><span className={cap}>Lead purpose</span><div className="mt-1.5 flex flex-wrap gap-2">{["buy", "rent", "invest", "off_plan"].map((p) => <button key={p} type="button" className={seg.purposes.includes(p) ? "btn text-xs" : "btn-ghost text-xs"} onClick={() => setSeg({ ...seg, purposes: toggle(seg.purposes, p) })}>{p.replace("_", "-")}</button>)}</div></div>
                <Lab t="Budget at least"><input className="input" type="number" min="0" value={seg.budgetMin} onChange={(e) => setSeg({ ...seg, budgetMin: e.target.value })} /></Lab>
                <Lab t="Budget at most"><input className="input" type="number" min="0" value={seg.budgetMax} onChange={(e) => setSeg({ ...seg, budgetMax: e.target.value })} /></Lab>
                <Lab t="Added after"><input className="input" type="date" value={seg.createdAfter} onChange={(e) => setSeg({ ...seg, createdAfter: e.target.value })} /></Lab>
                <Lab t="Added before"><input className="input" type="date" value={seg.createdBefore} onChange={(e) => setSeg({ ...seg, createdBefore: e.target.value })} /></Lab>
                {projects.length > 0 && <div className="sm:col-span-2"><span className={cap}>Interested in projects</span><div className="mt-1.5 flex flex-wrap gap-2">{projects.map((p) => <button key={p.id} type="button" className={seg.projectIds.includes(p.id) ? "btn text-xs" : "btn-ghost text-xs"} onClick={() => setSeg({ ...seg, projectIds: toggle(seg.projectIds, p.id) })}>{p.name}</button>)}</div></div>}
              </div>
            )}
            <div className="rounded-xl p-4" style={{ background: "var(--accent-soft)" }}>
              <p className="text-2xl font-bold">{count === null ? "..." : count.toLocaleString("en-US")}</p>
              <p className="muted text-sm">contacts match. People without consent for the chosen purpose, on the suppression list, or without a {channel === "email" ? "email address" : "phone number"} are skipped when the broadcast is prepared, and each skip is recorded with its reason.</p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-2">
              <span className={cap}>Approved {channel} templates</span>
              {templates.map((t) => <button key={t.versionId} type="button" onClick={() => setVersionId(t.versionId)} className="card p-3 text-left" style={{ boxShadow: versionId === t.versionId ? "0 0 0 2px var(--accent)" : undefined }}><span className="font-semibold">{t.name}</span><br /><span className="muted line-clamp-2 text-xs">{t.text}</span></button>)}
              {templates.length === 0 && <p className="muted text-sm">No approved {channel} templates yet. Create one under Templates, get it approved, then come back.</p>}
            </div>
            <div className="rounded-xl border p-4" style={{ borderColor: "var(--border)", background: "var(--card-2)" }}>
              <span className={cap}>Preview</span>
              {tpl ? <div className="mt-2 text-sm">{tpl.subject && <p className="mb-2 font-semibold">{tpl.subject}</p>}<p className="whitespace-pre-wrap">{tpl.text}</p></div> : <p className="muted mt-2 text-sm">Choose a template to preview it. Placeholders are filled per contact when sending.</p>}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Lab t="Send from"><select className="input" value={account?.id ?? ""} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.identity})</option>)}{accounts.length === 0 && <option value="">No {channel} account connected</option>}</select></Lab>
            <Lab t="Consent purpose (recipients must have agreed to this)"><select className="input" value={purposeCode} onChange={(e) => setPurposeCode(e.target.value)}>{setup.purposes.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Lab>
            <Lab t="Messages per minute (throttle)"><input className="input" type="number" min="1" max="6000" value={rate} onChange={(e) => setRate(e.target.value)} /></Lab>
            <div className="sm:col-span-2"><span className={cap}>When</span>
              <div className="mt-1.5 grid gap-3 sm:grid-cols-3" role="radiogroup">
                {([["draft", "Save as draft", "Review it first, launch later."], ["now", "Send now", "Starts as soon as it is prepared."], ["later", "Schedule", "Pick a date and time (Dubai)."]] as const).map(([v, l, h]) => <button key={v} type="button" role="radio" aria-checked={when === v} onClick={() => setWhen(v)} className="card p-3 text-left" style={{ boxShadow: when === v ? "0 0 0 2px var(--accent)" : undefined }}><span className="font-semibold">{l}</span><br /><span className="muted text-xs">{h}</span></button>)}
              </div>
              {when === "later" && <input type="datetime-local" className="input mt-3 w-auto" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Send at (Dubai time)" />}
            </div>
          </div>
        )}

        {step === 4 && (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {[["Name", name], ["Channel", channel], ["Audience", audMode === "saved" ? setup.segments.find((s) => s.id === segmentId)?.name : `${seg.name} (new)`], ["Matching contacts", count === null ? "-" : String(count)], ["Template", tpl?.name], ["Send from", account ? `${account.name} (${account.identity})` : "-"], ["Consent purpose", setup.purposes.find((p) => p.code === purposeCode)?.name], ["Throttle", `${rate} / minute`], ["When", when === "draft" ? "Saved as draft" : when === "now" ? "Send now" : `Scheduled ${at} (Dubai)`]].map(([k, v]) => <div key={k as string}><dt className="muted text-xs">{k}</dt><dd className="font-medium">{v ?? "-"}</dd></div>)}
          </dl>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <button type="button" className="btn-ghost" disabled={step === 0 || busy} onClick={() => { setErr(null); setStep(step - 1); }}>Back</button>
        <p role="alert" className="err min-w-0 flex-1 text-center text-sm">{err}</p>
        {step < 4 ? <button type="button" className="btn" onClick={next}>Continue</button> : <button type="button" className="btn" disabled={busy} onClick={launch}>{busy ? "Working..." : when === "draft" ? "Create draft" : when === "now" ? "Create and send" : "Create and schedule"}</button>}
      </div>
    </div>
  );
}
