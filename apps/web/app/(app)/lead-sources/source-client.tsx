"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Opt { id?: string; code?: string; name: string }

export function SourceForm({ sources, pools, projects }: { sources: Opt[]; pools: Opt[]; projects: Opt[] }) {
  const router = useRouter();
  const [f, setF] = useState({ name: "", kind: "portal", sourceCode: "", routeMode: "rules", poolId: "", projectId: "", defaultPurpose: "buy", campaign: "" });
  const [created, setCreated] = useState<{ publicId: string; secret: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const r = await postJson("/api/v1/lead-sources", { name: f.name, kind: f.kind, sourceCode: f.sourceCode || null, routeMode: f.routeMode, poolId: f.routeMode === "pool" ? f.poolId || null : null, projectId: f.projectId || null, defaultPurpose: f.defaultPurpose, campaign: f.campaign || null });
    if (!r.ok) return setMsg(errMsg(r));
    setCreated({ publicId: r.data.publicId, secret: r.data.secret }); setF({ ...f, name: "" }); router.refresh();
  }
  const lab = "flex flex-col gap-1.5 text-sm";
  const cap = "muted text-xs font-medium";
  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={save} className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className={`${lab} lg:col-span-2`}><span className={cap}>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="e.g. Bayut, Facebook lead form, Website contact form" /></label>
        <label className={lab}><span className={cap}>Type</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="portal">Property portal</option><option value="meta">Meta (Facebook / Instagram)</option><option value="website">Website form</option><option value="generic">Other system</option></select></label>
        <label className={lab}><span className={cap}>Count as source</span><select className="input" value={f.sourceCode} onChange={(e) => setF({ ...f, sourceCode: e.target.value })}><option value="">Default</option>{sources.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
        <label className={lab}><span className={cap}>New leads go to</span><select className="input" value={f.routeMode} onChange={(e) => setF({ ...f, routeMode: e.target.value })}><option value="rules">An agent, by routing rules</option><option value="pool">A pool (agents claim)</option></select></label>
        {f.routeMode === "pool" && <label className={lab}><span className={cap}>Pool</span><select className="input" value={f.poolId} onChange={(e) => setF({ ...f, poolId: e.target.value })} required><option value="">Choose...</option>{pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        <label className={lab}><span className={cap}>Project</span><select className="input" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">None</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className={lab}><span className={cap}>Default purpose</span><select className="input" value={f.defaultPurpose} onChange={(e) => setF({ ...f, defaultPurpose: e.target.value })}><option value="buy">Buy</option><option value="rent">Rent</option><option value="invest">Invest</option><option value="off_plan">Off-plan</option></select></label>
        <label className={lab}><span className={cap}>Campaign label</span><input className="input" value={f.campaign} onChange={(e) => setF({ ...f, campaign: e.target.value })} /></label>
        <div className="flex items-end gap-3 sm:col-span-2 lg:col-span-4"><button className="btn">Create source</button>{msg && <p role="alert" className="err text-sm">{msg}</p>}</div>
      </form>
      {created && <SecretBox publicId={created.publicId} secret={created.secret} onClose={() => setCreated(null)} />}
    </div>
  );
}

export function SecretBox({ publicId, secret, onClose }: { publicId: string; secret: string; onClose: () => void }) {
  const url = typeof window !== "undefined" ? `${window.location.origin}/api/v1/ingest/leads/${publicId}` : `/api/v1/ingest/leads/${publicId}`;
  const sample = `curl -X POST '${url}' \\\n  -H 'content-type: application/json' \\\n  -H "x-signature: sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac '${secret}' | sed 's/^.* //')" \\\n  -d "$BODY"   # BODY='{"id":"123","name":"Sara Ali","phone":"0501234567","message":"2BR in Marina"}'`;
  return (
    <div className="card p-4" style={{ borderColor: "var(--warn)" }} role="status">
      <p className="font-semibold">Copy the signing secret now: it is shown only once.</p>
      <dl className="mt-2 grid gap-2 text-sm"><div><dt className="muted text-xs">Endpoint (POST)</dt><dd className="break-all font-mono text-xs">{url}</dd></div><div><dt className="muted text-xs">Signing secret</dt><dd className="break-all font-mono text-xs">{secret}</dd></div></dl>
      <p className="muted mt-2 text-xs">Sign the raw request body with HMAC-SHA256 using the secret and send it in the <code>x-signature</code> header (Meta: <code>x-hub-signature-256</code>, verify token = the secret). Example:</p>
      <pre className="mt-1 overflow-x-auto rounded-lg p-3 text-xs" style={{ background: "var(--card-2)" }}>{sample}</pre>
      <button className="btn-ghost mt-3" onClick={onClose}>I have saved it</button>
    </div>
  );
}

export function SourceActions({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  const [pub, setPub] = useState("");
  return (
    <span className="flex flex-col items-end gap-2">
      <span className="flex gap-2">
        <button className="btn-ghost text-xs" onClick={async () => { await postJson(`/api/v1/lead-sources/${id}`, { active: !active }, "PATCH"); router.refresh(); }}>{active ? "Disable" : "Enable"}</button>
        <button className="btn-ghost text-xs" onClick={async () => { if (!confirm("Rotate the secret? The old one stops working immediately.")) return; const r = await postJson(`/api/v1/lead-sources/${id}/rotate`); if (r.ok) { setSecret(r.data.secret); setPub(document.getElementById(`pub-${id}`)?.textContent ?? ""); } }}>Rotate secret</button>
      </span>
      {secret && <SecretBox publicId={pub} secret={secret} onClose={() => setSecret(null)} />}
    </span>
  );
}
