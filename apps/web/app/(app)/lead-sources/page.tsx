import { getSequelize } from "@reales/database";
import { DEFAULT_SOURCES, listIngestSources, listPools, listProjects } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { SourceActions, SourceForm } from "./source-client";

export const metadata = { title: "Lead sources | Reales CRM" };

const dt = (v: unknown) => (v ? new Date(v as string).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) : "never");
const tone: Record<string, string> = { created: "badge-ok", duplicate: "badge-gray", rejected: "badge-danger" };

export default async function LeadSources() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "leadsource.manage")) return <NoAccess />;
  const sq = getSequelize();
  const [data, pools, projects]: [any, any[], any[]] = await Promise.all([listIngestSources(sq, ctx), listPools(sq, ctx).catch(() => []) as Promise<any[]>, hasPermission(ctx, "project.read") ? (listProjects(sq, ctx) as Promise<any[]>) : Promise.resolve([])]);
  const name = new Map<string, string>(data.sources.map((s: any) => [s.id, s.name]));
  return (
    <section className="flex flex-col gap-6">
      <div className="page-head"><div><h1>Lead sources</h1><p className="muted text-sm">Inbound endpoints for portals, Meta lead forms (through a connector such as Zapier or Make), website forms and other systems. Each delivery is signed, de-duplicated and recorded.</p></div></div>
      <SourceForm sources={DEFAULT_SOURCES.map((s) => ({ code: s.code, name: s.name }))} pools={pools.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }))} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
      <div className="card overflow-x-auto">
        <table className="t"><thead><tr><th>Source</th><th>Type</th><th>Endpoint id</th><th>Routing</th><th>Leads received</th><th>Last delivery</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.sources.map((s: any) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.6 }}>
                <td className="font-medium">{s.name}{s.campaign && <span className="muted block text-xs">{s.campaign}</span>}</td><td><span className="badge badge-gray">{s.kind}</span></td>
                <td className="font-mono text-xs" id={`pub-${s.id}`}>{s.publicId}{s.kind === "website" && s.active && <span className="mt-1 block font-sans"><a href={`/f/${s.publicId}`} target="_blank" rel="noopener noreferrer">Public form</a> - <a href={`/api/v1/lead-sources/${s.id}/qr`} download={`lead-form-${s.publicId}.svg`}>QR code</a></span>}</td><td>{s.routeMode === "pool" ? "Pool" : "Routing rules"}</td><td>{s.totalReceived}</td><td>{dt(s.lastReceivedAt)}</td>
                <td><span className={`badge ${s.active ? "badge-ok" : "badge-gray"}`}>{s.active ? "active" : "disabled"}</span></td><td className="text-right"><SourceActions id={s.id} active={!!s.active} /></td>
              </tr>
            ))}
            {data.sources.length === 0 && <tr><td colSpan={8} className="muted">No sources yet.</td></tr>}
          </tbody></table>
      </div>
      <div className="card overflow-x-auto"><h2 className="p-4 pb-2 font-semibold">Recent deliveries</h2>
        <table className="t"><thead><tr><th>Received</th><th>Source</th><th>Sender id</th><th>Result</th><th>Detail</th></tr></thead>
          <tbody>
            {data.events.map((e: any) => <tr key={e.id}><td>{dt(e.receivedAt)}</td><td>{name.get(e.sourceId) ?? "-"}</td><td className="font-mono text-xs">{e.externalId}</td><td><span className={`badge ${tone[e.status]}`}>{e.status}</span></td><td className="text-xs">{e.error ?? (e.leadId ? "Lead created" : "")}</td></tr>)}
            {data.events.length === 0 && <tr><td colSpan={5} className="muted">Nothing received yet.</td></tr>}
          </tbody></table>
      </div>
    </section>
  );
}
