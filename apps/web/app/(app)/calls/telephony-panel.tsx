"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type T = { configured: boolean; enabled: boolean; accountSid: string | null; fromNumber: string | null; statusUrl: string; connectUrl: string };

/** Administrator setup for Twilio. The auth token is only ever sent to the server; leave it empty to keep the saved one. */
export function TelephonyPanel({ initial }: { initial: T }) {
  const router = useRouter();
  const [f, setF] = useState({ accountSid: initial.accountSid ?? "", authToken: "", fromNumber: initial.fromNumber ?? "", enabled: initial.enabled || !initial.configured });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const r = await postJson("/api/v1/telephony", { accountSid: f.accountSid, ...(f.authToken ? { authToken: f.authToken } : {}), fromNumber: f.fromNumber, enabled: f.enabled }, "PUT");
    setBusy(false);
    if (r.ok) { setF({ ...f, authToken: "" }); setMsg("Saved."); router.refresh(); } else setMsg(errMsg(r));
  }
  return (
    <details className="card p-3">
      <summary className="cursor-pointer font-medium">Phone system (Twilio) {initial.configured ? (initial.enabled ? "- connected" : "- switched off") : "- not set up"}</summary>
      <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={save}>
        <label className="text-sm"><span className="muted text-xs font-medium">Account SID</span><input className="input mt-1" value={f.accountSid} onChange={(e) => setF({ ...f, accountSid: e.target.value })} placeholder="AC..." required /></label>
        <label className="text-sm"><span className="muted text-xs font-medium">Auth token {initial.configured && "(leave empty to keep)"}</span><input className="input mt-1" type="password" autoComplete="off" value={f.authToken} onChange={(e) => setF({ ...f, authToken: e.target.value })} /></label>
        <label className="text-sm"><span className="muted text-xs font-medium">Company number</span><input className="input mt-1" value={f.fromNumber} onChange={(e) => setF({ ...f, fromNumber: e.target.value })} placeholder="+971..." required /></label>
        <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Enabled</label>
        <p className="muted text-xs sm:col-span-2">In Twilio, set the number&apos;s &quot;call status changes&quot; webhook to <code>{initial.statusUrl}</code> so calls are logged automatically. Click-to-call needs your own mobile number in your profile.</p>
        <div className="flex items-center gap-3 sm:col-span-2"><button className="btn" disabled={busy}>{busy ? "Saving..." : "Save"}</button>{msg && <span role="status" className="text-sm">{msg}</span>}</div>
      </form>
    </details>
  );
}
