"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Acct { id: string; channel: string; provider: string; name: string; identity: string; status: string; phoneNumberId: string | null; hasToken: boolean }
interface Data { accounts: Acct[]; providers: string[]; whatsappCloud: { appSecretSet: boolean; verifyTokenSet: boolean; webhookPath: string } }

export function ChannelsClient({ data }: { data: Data }) {
  const router = useRouter();
  const [f, setF] = useState({ provider: data.providers.includes("whatsapp_cloud") ? "whatsapp_cloud" : data.providers[0] ?? "mock", name: "", identity: "", phoneNumberId: "", accessToken: "", wabaId: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const wa = f.provider === "whatsapp_cloud";
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  async function add(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const r = await postJson("/api/v1/channel-accounts", { channel: "whatsapp", provider: f.provider, name: f.name, identity: f.identity, ...(wa ? { config: { phoneNumberId: f.phoneNumberId, accessToken: f.accessToken, ...(f.wabaId ? { wabaId: f.wabaId } : {}) } } : {}) });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMsg({ ok: true, text: "Account added." }); setF({ ...f, name: "", identity: "", phoneNumberId: "", accessToken: "", wabaId: "" }); router.refresh();
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="card overflow-x-auto" data-server-table>
        <table className="t"><thead><tr><th>Name</th><th>Channel</th><th>Provider</th><th>Number or address</th><th>Credentials</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.accounts.map((a) => <tr key={a.id}><td className="font-medium">{a.name}</td><td>{a.channel}</td><td>{a.provider}</td><td>{a.identity}</td><td>{a.provider === "whatsapp_cloud" ? (a.hasToken ? `Token stored (phone id ${a.phoneNumberId})` : <span className="err">Missing</span>) : "-"}</td><td><span className={`badge ${a.status === "active" ? "badge-ok" : "badge-gray"}`}>{a.status}</span></td>
              <td className="text-right"><button className="btn-ghost text-xs" onClick={async () => { await postJson(`/api/v1/channel-accounts/${a.id}`, { status: a.status === "active" ? "disabled" : "active" }, "PATCH"); router.refresh(); }}>{a.status === "active" ? "Disable" : "Enable"}</button></td></tr>)}
            {data.accounts.length === 0 && <tr><td colSpan={7} className="muted">No accounts yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={add} className="card grid gap-3 p-4 text-sm sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Add a WhatsApp account</h2>
        <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Provider</span><select className="input" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{data.providers.map((p) => <option key={p} value={p}>{p === "whatsapp_cloud" ? "WhatsApp Business Cloud API (Meta)" : p}</option>)}</select></label>
        <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Name</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Sales WhatsApp" /></label>
        <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">{wa ? "WhatsApp number (international format)" : "Number or address"}</span><input className="input" required value={f.identity} onChange={(e) => setF({ ...f, identity: e.target.value })} placeholder="+971501234567" /></label>
        {wa && (
          <>
            <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Phone number id (from Meta)</span><input className="input" required value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} /></label>
            <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">Permanent access token</span><input className="input" type="password" autoComplete="off" required value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} /></label>
            <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">WhatsApp Business account id (optional)</span><input className="input" value={f.wabaId} onChange={(e) => setF({ ...f, wabaId: e.target.value })} /></label>
          </>
        )}
        <div className="flex items-center gap-3 sm:col-span-2"><button className="btn" disabled={busy}>{busy ? "Saving..." : "Add account"}</button>{msg && <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "muted" : "err"}>{msg.text}</span>}</div>
      </form>
      <div className="card p-4 text-sm">
        <h2 className="mb-2 font-semibold">Connecting WhatsApp Cloud (one-time, in Meta)</h2>
        <ol className="list-decimal pl-5 leading-7">
          <li>In your Meta app, add the WhatsApp product, get the phone number id and a permanent access token, and add the account above.</li>
          <li>Webhook callback URL: <code>{origin}{data.whatsappCloud.webhookPath}</code>, subscribed to <b>messages</b>.</li>
          <li>Set <code>META_APP_SECRET</code> {data.whatsappCloud.appSecretSet ? <span className="badge badge-ok">set</span> : <span className="badge badge-warn">not set</span>} and <code>META_VERIFY_TOKEN</code> {data.whatsappCloud.verifyTokenSet ? <span className="badge badge-ok">set</span> : <span className="badge badge-warn">not set</span>} on the server, and use the same verify token in Meta.</li>
          <li>Free-form replies work inside the 24-hour WhatsApp window. Messages to people who have not written in the last 24 hours need a Meta-approved template: register it in Meta, then give the CRM template the same name and language so it is sent as that template (variables go in as 1, 2, 3 in order). A template without a Meta name is sent as plain text, which Meta refuses outside the window.</li>
        </ol>
      </div>
    </div>
  );
}
