"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const lab = "flex flex-col gap-1.5 text-sm";
const cap = "muted text-xs font-medium";
const dt = (v: unknown) => (v ? new Date(v as string).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) : "never");

export function NewAccount({ providers }: { providers: { code: string; label: string }[] }) {
  const router = useRouter();
  const [f, setF] = useState({ provider: providers[0]?.code ?? "bayut", name: "" });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form className="card flex flex-wrap items-end gap-3 p-4" onSubmit={async (e) => { e.preventDefault(); setMsg(null); const r = await postJson("/api/v1/portal-connections", { provider: f.provider, name: f.name, mode: "export" }); if (!r.ok) return setMsg(errMsg(r)); setF({ ...f, name: "" }); router.refresh(); }}>
      <label className={lab}><span className={cap}>Add a portal</span><select className="input" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{providers.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}</select></label>
      <label className={`${lab} grow`}><span className={cap}>Account name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Bayut - Main office" required /></label>
      <button className="btn">Add account</button>{msg && <p role="alert" className="err w-full text-sm">{msg}</p>}
    </form>
  );
}

export function AccountCard({ a }: { a: any }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [c, setC] = useState({ baseUrl: a.baseUrl ?? "", apiKey: "", apiSecret: "", locationMap: "" });
  const [showCreds, setShowCreds] = useState(false);
  const isPf = a.provider === "property_finder";
  async function run(p: Promise<{ ok: boolean; data: any; status: number }>, done: string) { setBusy(true); setMsg(null); const r = await p; setBusy(false); if (!r.ok) return setMsg({ ok: false, text: errMsg(r as any) }); setMsg({ ok: true, text: done }); router.refresh(); return r; }
  return (
    <div className="card flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{a.name}</h2><p className="muted text-xs">{a.provider} &middot; {a.mode === "api" ? "live API" : "XML feed"}</p></div><span className={`badge ${a.status === "active" ? "badge-ok" : "badge-gray"}`}>{a.status}</span></div>
      <div className="text-sm"><p className="muted text-xs">Feed address (give this to the portal)</p>
        {a.feedUrl ? <p className="break-all font-mono text-xs">{a.feedUrl}</p> : <p className="muted text-xs">Created when you save credentials or rotate the token.</p>}
        <div className="mt-1 flex gap-2"><button className="btn-ghost text-xs" disabled={busy} onClick={() => run(postJson(`/api/v1/distribution/accounts/${a.id}/feed-token`), "New feed address created. Tell the portal: the old one no longer works.")}>{a.feedUrl ? "Rotate feed address" : "Create feed address"}</button></div></div>
      <div className="text-sm"><p className="muted text-xs">Listings on this portal</p><p>{Object.entries(a.listings).map(([k, v]) => `${v} ${k}`).join(" · ") || "None yet"}</p></div>
      {isPf && (
        <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">Live API</p>{a.hasCredentials ? <span className="badge badge-ok">credentials saved ({a.apiKeyMasked})</span> : <span className="badge badge-gray">no credentials</span>}</div>
          {a.lastTestedAt && <p className={`mt-1 text-xs ${a.lastTestOk ? "" : "err"}`}>Last test {dt(a.lastTestedAt)}: {a.lastTestMessage}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button className="btn-ghost text-xs" onClick={() => setShowCreds(!showCreds)}>{a.hasCredentials ? "Replace credentials" : "Add credentials"}</button>
            {a.hasCredentials && <button className="btn-ghost text-xs" disabled={busy} onClick={() => run(postJson(`/api/v1/distribution/accounts/${a.id}/test`), "Test finished.")}>Test connection</button>}
            {a.hasCredentials && a.mode !== "api" && <button className="btn text-xs" disabled={busy || a.lastTestOk !== true} title={a.lastTestOk !== true ? "Test the connection first" : ""} onClick={() => run(postJson(`/api/v1/distribution/accounts/${a.id}/mode`, { mode: "api" }, "PUT"), "Live API mode is on.")}>Switch to live API</button>}
            {a.mode === "api" && <button className="btn-ghost text-xs" disabled={busy} onClick={() => run(postJson(`/api/v1/distribution/accounts/${a.id}/mode`, { mode: "export" }, "PUT"), "Back to XML feed.")}>Back to XML feed</button>}
          </div>
          {showCreds && (
            <form className="mt-3 grid gap-3" onSubmit={async (e) => { e.preventDefault(); let locationMap: Record<string, string> | undefined; if (c.locationMap.trim()) { locationMap = {}; for (const line of c.locationMap.split("\n")) { const [k, v] = line.split("="); if (k?.trim() && v?.trim()) locationMap[k.trim()] = v.trim(); } } const r = await run(postJson(`/api/v1/distribution/accounts/${a.id}/credentials`, { baseUrl: c.baseUrl, apiKey: c.apiKey, apiSecret: c.apiSecret, ...(locationMap && { locationMap }) }, "PUT"), "Credentials saved (encrypted). Now press Test connection."); if (r?.ok) { setShowCreds(false); setC({ ...c, apiKey: "", apiSecret: "" }); } }}>
              <label className={lab}><span className={cap}>API address (from Property Finder)</span><input className="input" value={c.baseUrl} onChange={(e) => setC({ ...c, baseUrl: e.target.value })} placeholder="https://..." required /></label>
              <label className={lab}><span className={cap}>API key</span><input className="input" value={c.apiKey} onChange={(e) => setC({ ...c, apiKey: e.target.value })} autoComplete="off" required /></label>
              <label className={lab}><span className={cap}>API secret</span><input className="input" type="password" value={c.apiSecret} onChange={(e) => setC({ ...c, apiSecret: e.target.value })} autoComplete="new-password" required /></label>
              <label className={lab}><span className={cap}>Location ids (optional, one per line: Dubai Marina=123)</span><textarea className="input min-h-20" value={c.locationMap} onChange={(e) => setC({ ...c, locationMap: e.target.value })} /></label>
              <button className="btn w-fit">Save credentials</button>
            </form>
          )}
        </div>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p>}
    </div>
  );
}
