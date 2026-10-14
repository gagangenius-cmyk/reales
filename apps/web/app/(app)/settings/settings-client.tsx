"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

function useAction() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return {
    msg,
    run: async (r: Promise<{ ok: boolean; data: any; status: number }>, ok: string) => {
      setMsg(null);
      const res = await r;
      if (!res.ok) return setMsg({ ok: false, text: errMsg(res as any) });
      setMsg({ ok: true, text: ok });
      router.refresh();
    },
  };
}
const Msg = ({ m }: { m: { ok: boolean; text: string } | null }) => (m ? <p role={m.ok ? "status" : "alert"} className={`w-full text-sm ${m.ok ? "" : "err"}`}>{m.text}</p> : null);

export function QuotaForm() {
  const a = useAction();
  const [meter, setMeter] = useState("messages_sent");
  const [limit, setLimit] = useState("");
  return (
    <form className="card flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); a.run(postJson("/api/v1/quotas", { meter, limit: limit === "" ? null : Number(limit) }, "PUT"), "Saved."); }}>
      <label className="text-sm">Meter<select className="input mt-1" value={meter} onChange={(e) => setMeter(e.target.value)}><option value="messages_sent">Messages sent</option><option value="ai_tokens">AI tokens</option></select></label>
      <label className="text-sm">Monthly limit (empty = no limit)<input className="input mt-1" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
      <button className="btn">Set limit</button><Msg m={a.msg} />
    </form>
  );
}

export function SsoForm() {
  const a = useAction();
  const [f, setF] = useState({ name: "", issuer: "", clientId: "", clientSecret: "", authorizationEndpoint: "", tokenEndpoint: "", jwksUri: "", emailDomains: "", jitRoleKey: "", enforce: false, trustIdpMfa: false });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  return (
    <form className="card flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => {
      e.preventDefault();
      a.run(postJson("/api/v1/sso-connections", {
        name: f.name, issuer: f.issuer, clientId: f.clientId, ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}), authorizationEndpoint: f.authorizationEndpoint, tokenEndpoint: f.tokenEndpoint, jwksUri: f.jwksUri,
        emailDomains: f.emailDomains.split(",").map((d) => d.trim()).filter(Boolean), ...(f.jitRoleKey ? { jitEnabled: true, jitRoleKey: f.jitRoleKey } : {}), enforce: f.enforce, trustIdpMfa: f.trustIdpMfa,
      }), "Connection added.");
    }}>
      <h3 className="w-full font-semibold">Add a connection</h3>
      <label className="text-sm">Name<input className="input mt-1" value={f.name} onChange={set("name")} required /></label>
      <label className="text-sm">Issuer URL<input className="input mt-1" value={f.issuer} onChange={set("issuer")} required placeholder="https://login.example.com" /></label>
      <label className="text-sm">Client id<input className="input mt-1" value={f.clientId} onChange={set("clientId")} required /></label>
      <label className="text-sm">Client secret<input className="input mt-1" type="password" value={f.clientSecret} onChange={set("clientSecret")} autoComplete="off" /></label>
      <label className="text-sm">Authorization endpoint<input className="input mt-1" value={f.authorizationEndpoint} onChange={set("authorizationEndpoint")} required /></label>
      <label className="text-sm">Token endpoint<input className="input mt-1" value={f.tokenEndpoint} onChange={set("tokenEndpoint")} required /></label>
      <label className="text-sm">JWKS URI<input className="input mt-1" value={f.jwksUri} onChange={set("jwksUri")} required /></label>
      <label className="text-sm">Email domains (comma separated)<input className="input mt-1" value={f.emailDomains} onChange={set("emailDomains")} required placeholder="company.com" /></label>
      <label className="text-sm">Auto-create users with role (optional)<input className="input mt-1" value={f.jitRoleKey} onChange={set("jitRoleKey")} placeholder="agent" /></label>
      <label className="text-sm"><input type="checkbox" checked={f.enforce} onChange={set("enforce")} /> Require SSO (disable password sign-in for these domains)</label>
      <label className="text-sm"><input type="checkbox" checked={f.trustIdpMfa} onChange={set("trustIdpMfa")} /> Trust the identity provider's MFA</label>
      <button className="btn">Add connection</button><Msg m={a.msg} />
    </form>
  );
}

export function SsoRowActions({ id, status }: { id: string; status: string }) {
  const a = useAction();
  return <span><button className="btn-ghost text-xs" onClick={() => a.run(postJson(`/api/v1/sso-connections/${id}/status`, { status: status === "active" ? "disabled" : "active" }), "Updated.")}>{status === "active" ? "Disable" : "Enable"}</button><Msg m={a.msg} /></span>;
}

export function PolicyForm({ current }: { current: { allowedRegions: string[]; allowCrossBorder: boolean; requireRegisteredProviders: boolean } | null }) {
  const a = useAction();
  const [regions, setRegions] = useState((current?.allowedRegions ?? ["ae-uae"]).join(", "));
  const [cross, setCross] = useState(current?.allowCrossBorder ?? false);
  const [require, setRequire] = useState(current?.requireRegisteredProviders ?? true);
  return (
    <form className="card flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); a.run(postJson("/api/v1/data-processing-policy", { allowedRegions: regions.split(",").map((r) => r.trim()).filter(Boolean), allowCrossBorder: cross, requireRegisteredProviders: require }, "PUT"), "Policy saved."); }}>
      <label className="grow text-sm">Allowed regions (comma separated)<input className="input mt-1 w-full" value={regions} onChange={(e) => setRegions(e.target.value)} required /></label>
      <label className="text-sm"><input type="checkbox" checked={cross} onChange={(e) => setCross(e.target.checked)} /> Allow cross-border transfers</label>
      <label className="text-sm"><input type="checkbox" checked={require} onChange={(e) => setRequire(e.target.checked)} /> Only registered, approved providers</label>
      <button className="btn">{current ? "Update policy" : "Enable policy"}</button><Msg m={a.msg} />
    </form>
  );
}

export function SubprocessorForm() {
  const a = useAction();
  const [f, setF] = useState({ code: "", name: "", purpose: "", region: "ae-uae", status: "approved", dpaSignedOn: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="card flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); a.run(postJson("/api/v1/subprocessors", { ...f, ...(f.dpaSignedOn ? {} : { dpaSignedOn: undefined }) }, "PUT"), "Saved."); }}>
      <h3 className="w-full font-semibold">Add or update a sub-processor</h3>
      <label className="text-sm">Provider code<input className="input mt-1" value={f.code} onChange={set("code")} required placeholder="mock" /></label>
      <label className="text-sm">Name<input className="input mt-1" value={f.name} onChange={set("name")} required /></label>
      <label className="text-sm">Purpose<input className="input mt-1" value={f.purpose} onChange={set("purpose")} required /></label>
      <label className="text-sm">Processing region<input className="input mt-1" value={f.region} onChange={set("region")} required /></label>
      <label className="text-sm">Status<select className="input mt-1" value={f.status} onChange={set("status")}><option>approved</option><option>pending</option><option>blocked</option></select></label>
      <label className="text-sm">DPA signed on<input className="input mt-1" type="date" value={f.dpaSignedOn} onChange={set("dpaSignedOn")} /></label>
      <button className="btn">Save</button><Msg m={a.msg} />
    </form>
  );
}
