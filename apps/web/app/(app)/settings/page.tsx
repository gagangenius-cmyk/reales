import { getSequelize } from "@reales/database";
import { getDataProcessingPolicy, getUsageSummary, listSsoConnections, listSubprocessors } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { PolicyForm, QuotaForm, SsoForm, SsoRowActions, SubprocessorForm } from "./settings-client";

export const metadata = { title: "Settings | Reales CRM" };

export default async function Settings() {
  const ctx = await requireContext();
  const sso = hasPermission(ctx, "sso.manage"), dp = hasPermission(ctx, "dataprocessing.manage"), usage = hasPermission(ctx, "usage.read");
  if (!sso && !dp && !usage) return <NoAccess />;
  const sq = getSequelize();
  const [conns, policy, subs, use] = await Promise.all([
    sso ? (listSsoConnections(sq, ctx) as Promise<any[]>) : Promise.resolve([]),
    dp ? getDataProcessingPolicy(sq, ctx) : Promise.resolve(null),
    dp ? (listSubprocessors(sq, ctx) as Promise<any[]>) : Promise.resolve([]),
    usage ? getUsageSummary(sq, ctx) : Promise.resolve(null),
  ]);
  return (
    <section className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      {usage && use && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Usage this month ({use.period})</h2>
          <div className="card overflow-x-auto p-2">
            <table className="t"><thead><tr><th>Meter</th><th>Used</th><th>Monthly limit</th></tr></thead>
              <tbody>{use.meters.map((m) => <tr key={m.meter}><td>{m.meter.replace(/_/g, " ")}</td><td>{m.used.toLocaleString("en-US")}</td><td>{m.limit === null ? "No limit" : m.limit.toLocaleString("en-US")}</td></tr>)}
                {use.meters.length === 0 && <tr><td colSpan={3} className="muted">No usage yet.</td></tr>}</tbody></table>
          </div>
          {hasPermission(ctx, "quota.manage") && <QuotaForm />}
        </div>
      )}

      {sso && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Single sign-on (OpenID Connect)</h2>
          <div className="card overflow-x-auto p-2">
            <table className="t"><thead><tr><th>Name</th><th>Domains</th><th>Provisioning</th><th>Password login</th><th>Status</th><th /></tr></thead>
              <tbody>{conns.map((c) => <tr key={c.id}><td>{c.name}<br /><span className="muted text-xs">{c.issuer}</span></td><td>{(c.emailDomains ?? []).join(", ")}</td><td>{c.jitEnabled ? `auto (${c.jitRoleKey})` : "existing users only"}</td><td>{c.enforce ? "disabled for these domains" : "allowed"}</td><td>{c.status}</td><td><SsoRowActions id={c.id} status={c.status} /></td></tr>)}
                {conns.length === 0 && <tr><td colSpan={6} className="muted">No connection configured.</td></tr>}</tbody></table>
          </div>
          <SsoForm />
        </div>
      )}

      {dp && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Data processing and sub-processors</h2>
          <p className="muted text-sm">Without a policy nothing is restricted. With one, messages and e-signature requests only go to approved providers inside the allowed regions.</p>
          <PolicyForm current={policy as any} />
          <div className="card overflow-x-auto p-2">
            <table className="t"><thead><tr><th>Code</th><th>Name</th><th>Purpose</th><th>Region</th><th>Status</th><th>DPA signed</th></tr></thead>
              <tbody>{subs.map((s) => <tr key={s.id}><td>{s.code}</td><td>{s.name}</td><td>{s.purpose}</td><td>{s.region}</td><td>{s.status}</td><td>{s.dpaSignedOn ?? "-"}</td></tr>)}
                {subs.length === 0 && <tr><td colSpan={6} className="muted">No sub-processors registered.</td></tr>}</tbody></table>
          </div>
          <SubprocessorForm />
        </div>
      )}
    </section>
  );
}
