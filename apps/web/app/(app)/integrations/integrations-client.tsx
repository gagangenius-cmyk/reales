"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useStepUp } from "@/components/step-up";
import { errMsg, postJson } from "@/lib/client";

const fmt = (v?: string | null) => (v ? new Date(v).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "never");
const EVENT_HINTS = ["*", "lead.*", "lead.created", "lead.assigned", "lead.stage_changed", "contact.created", "deal.*", "deal.closed", "commission.approved", "listing.created", "invoice.issued", "claim.*"];

export function ApiKeysPanel({ keys, scopes }: { keys: any[]; scopes: string[] }) {
  const router = useRouter();
  const { guard, form } = useStepUp();
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const readOnly = scopes.filter((s) => s.endsWith(".read"));

  async function create(e?: React.FormEvent) {
    e?.preventDefault(); setMsg(null);
    const r = await guard(() => postJson("/api/v1/api-keys", { name, scopes: picked, expiresInDays: days }));
    if (r.data?.error?.code === "step_up_required") return;
    if (!r.ok) return setMsg(errMsg(r));
    setFresh(r.data.key); setName(""); setPicked([]); router.refresh();
  }
  async function revoke(id: string) { await postJson(`/api/v1/api-keys/${id}`, undefined, "DELETE"); router.refresh(); }
  const shown = scopes.filter((s) => s.includes(filter.toLowerCase()));
  return (
    <div className="card flex flex-col gap-4 p-5">
      <div><h2 className="font-semibold">API keys</h2><p className="muted text-sm">Send the key as <code>Authorization: Bearer rk_…</code>. A key acts as you, limited to the permissions you tick, and can never manage keys or webhooks. It is shown once.</p></div>
      {fresh && <div className="rounded border p-3 text-sm" style={{ borderColor: "var(--accent)" }}><p className="font-medium">Copy your new key now. It will not be shown again.</p><code className="mt-1 block break-all">{fresh}</code><button className="btn-ghost mt-2 text-xs" onClick={() => setFresh(null)}>I have copied it</button></div>}
      <form onSubmit={create} className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-1.5 text-sm md:col-span-2"><span className="muted text-xs font-medium">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required placeholder="Accounting export" /></label>
          <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Expires after (days)</span><input className="input" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm"><span className="muted text-xs font-medium">Permissions</span>
          <button type="button" className="btn-ghost text-xs" onClick={() => setPicked(readOnly)}>All read-only</button>
          <button type="button" className="btn-ghost text-xs" onClick={() => setPicked([])}>Clear</button>
          <input className="input w-48" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} /><span className="muted text-xs">{picked.length} selected</span></div>
        <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto text-sm md:grid-cols-3">
          {shown.map((s) => <label key={s} className="flex items-center gap-2"><input type="checkbox" checked={picked.includes(s)} onChange={(e) => setPicked(e.target.checked ? [...picked, s] : picked.filter((x) => x !== s))} />{s}</label>)}
        </div>
        <div className="flex items-center gap-3"><button className="btn" disabled={!name.trim() || !picked.length}>Create key</button><p role="alert" className="err text-sm">{msg}</p></div>
      </form>
      {form}
      <table className="w-full text-sm"><thead><tr className="muted text-left text-xs"><th>Name</th><th>Prefix</th><th>Permissions</th><th>Last used</th><th>Expires</th><th /></tr></thead>
        <tbody>{keys.map((k) => (
          <tr key={k.id} className="border-t" style={{ borderColor: "var(--border)" }}>
            <td className="py-2">{k.name}{k.revokedAt && <span className="badge badge-danger ml-2">revoked</span>}</td><td><code>{k.keyPrefix}</code></td>
            <td title={(k.scopes ?? []).join(", ")}>{(k.scopes ?? []).length}</td><td>{fmt(k.lastUsedAt)}</td><td>{fmt(k.expiresAt)}</td>
            <td className="text-right">{!k.revokedAt && <button className="btn-ghost text-xs" onClick={() => revoke(k.id)}>Revoke</button>}</td>
          </tr>))}
          {keys.length === 0 && <tr><td colSpan={6} className="muted py-3">No keys yet.</td></tr>}</tbody></table>
    </div>
  );
}

export function WebhooksPanel({ endpoints }: { endpoints: any[] }) {
  const router = useRouter();
  const [f, setF] = useState({ name: "", url: "", events: "lead.*" });
  const [msg, setMsg] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  async function create(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const r = await postJson("/api/v1/webhook-endpoints", { name: f.name, url: f.url, eventTypes: f.events.split(/[\s,]+/).filter(Boolean) });
    if (!r.ok) return setMsg(errMsg(r));
    setSecret(r.data.secret); setF({ name: "", url: "", events: "lead.*" }); router.refresh();
  }
  async function toggle(e: any) { await postJson("/api/v1/webhook-endpoints", { id: e.id, name: e.name, url: e.url, eventTypes: e.eventTypes, active: !e.active }); router.refresh(); }
  async function remove(id: string) { await postJson(`/api/v1/webhook-endpoints/${id}`, undefined, "DELETE"); router.refresh(); }
  async function rotate(id: string) { const r = await postJson(`/api/v1/webhook-endpoints/${id}/rotate`); if (r.ok) setSecret(r.data.secret); }
  async function test(id: string) {
    const r = await postJson(`/api/v1/webhook-endpoints/${id}/test`);
    setTestMsg({ ...testMsg, [id]: r.ok ? (r.data.status === "delivered" ? `Delivered (HTTP ${r.data.responseStatus})` : `Failed: ${r.data.lastError ?? "no response"}`) : errMsg(r) });
    router.refresh();
  }
  async function show(id: string) {
    if (open === id) return setOpen(null);
    const r = await fetch(`/api/v1/webhook-endpoints/${id}/deliveries`); const d = await r.json(); setDeliveries(d.deliveries ?? []); setOpen(id);
  }
  async function retry(id: string, endpointId: string) { await postJson(`/api/v1/webhook-deliveries/${id}`); setOpen(null); await show(endpointId); }
  return (
    <div className="card flex flex-col gap-4 p-5">
      <div><h2 className="font-semibold">Webhooks</h2><p className="muted text-sm">We POST a JSON event to your HTTPS address. Each request carries <code>X-Reales-Signature: t=…,v1=…</code>, an HMAC-SHA256 of <code>timestamp.body</code> with your signing secret. Failed deliveries are retried for several hours.</p></div>
      {secret && <div className="rounded border p-3 text-sm" style={{ borderColor: "var(--accent)" }}><p className="font-medium">Signing secret (shown once)</p><code className="break-all">{secret}</code><button className="btn-ghost ml-3 text-xs" onClick={() => setSecret(null)}>Done</button></div>}
      <form onSubmit={create} className="grid gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} /></label>
        <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">URL (https)</span><input className="input" type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required placeholder="https://example.com/hooks/reales" /></label>
        <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Events (comma separated)</span><input className="input" list="event-hints" value={f.events} onChange={(e) => setF({ ...f, events: e.target.value })} required /><datalist id="event-hints">{EVENT_HINTS.map((h) => <option key={h} value={h} />)}</datalist></label>
        <div className="flex items-center gap-3 md:col-span-3"><button className="btn">Add endpoint</button><p role="alert" className="err text-sm">{msg}</p></div>
      </form>
      <div className="flex flex-col gap-3">
        {endpoints.map((e) => (
          <div key={e.id} className="rounded border p-3" style={{ borderColor: "var(--border)" }}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><p className="font-medium">{e.name} {e.active ? <span className="badge badge-ok">on</span> : <span className="badge badge-danger">off</span>}</p>
                <p className="muted break-all text-xs">{e.url}</p><p className="muted text-xs">{(e.eventTypes ?? []).join(", ")} · delivered {e.counts?.delivered ?? 0} · pending {e.counts?.pending ?? 0} · failed {e.counts?.failed ?? 0}</p>
                {e.disabledReason && <p className="err text-xs">{e.disabledReason}</p>}{testMsg[e.id] && <p className="text-xs">{testMsg[e.id]}</p>}</div>
              <div className="flex flex-wrap gap-2"><button className="btn-ghost text-xs" onClick={() => test(e.id)}>Send test</button><button className="btn-ghost text-xs" onClick={() => show(e.id)}>Deliveries</button><button className="btn-ghost text-xs" onClick={() => toggle(e)}>{e.active ? "Turn off" : "Turn on"}</button><button className="btn-ghost text-xs" onClick={() => rotate(e.id)}>New secret</button><button className="btn-ghost text-xs" onClick={() => remove(e.id)}>Delete</button></div>
            </div>
            {open === e.id && <table className="mt-3 w-full text-xs"><thead><tr className="muted text-left"><th>When</th><th>Event</th><th>Status</th><th>Tries</th><th>Response</th><th /></tr></thead>
              <tbody>{deliveries.map((d) => <tr key={d.id} className="border-t" style={{ borderColor: "var(--border)" }}><td>{fmt(d.createdAt)}</td><td>{d.eventType}</td><td>{d.status}</td><td>{d.attempts}</td><td>{d.responseStatus ?? d.lastError ?? ""}</td><td>{d.status !== "delivered" && <button className="btn-ghost" onClick={() => retry(d.id, e.id)}>Retry</button>}</td></tr>)}
                {deliveries.length === 0 && <tr><td colSpan={6} className="muted py-2">Nothing delivered yet.</td></tr>}</tbody></table>}
          </div>))}
        {endpoints.length === 0 && <p className="muted text-sm">No endpoints yet.</p>}
      </div>
    </div>
  );
}
