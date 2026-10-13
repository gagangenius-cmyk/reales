import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listLeads, listPipelines } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { NewLeadForm } from "./new-lead-form";

export const metadata = { title: "Leads | Reales CRM" };

export default async function Leads({ searchParams }: { searchParams: Promise<{ status?: string; mine?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "lead.read")) return <NoAccess />;
  const sp = await searchParams;
  const status = ["open", "won", "lost"].includes(sp.status ?? "") ? sp.status : undefined;
  const sq = getSequelize();
  const [leads, pipelines] = await Promise.all([
    listLeads(sq, ctx, { limit: 100, offset: 0, status, mine: sp.mine === "true" }) as Promise<any[]>,
    listPipelines(sq, ctx) as Promise<any[]>,
  ]);
  const stageName = new Map<string, string>(pipelines.flatMap((p) => p.stages.map((s: any) => [s.id, s.name] as [string, string])));
  return (
    <section>
      <h1 className="text-2xl font-semibold">Leads</h1>
      <nav className="mt-3 flex gap-2 text-sm" aria-label="Lead filters">
        <Link className="btn-ghost" href="/leads">All</Link>
        <Link className="btn-ghost" href="/leads?status=open">Open</Link>
        <Link className="btn-ghost" href="/leads?status=won">Won</Link>
        <Link className="btn-ghost" href="/leads?status=lost">Lost</Link>
        <Link className="btn-ghost" href="/leads?mine=true">Mine</Link>
      </nav>
      {can(ctx, "lead.create") && <NewLeadForm />}
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Received</th><th>Purpose</th><th>Stage</th><th>Status</th><th>Budget (max)</th><th></th></tr></thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                <td>{l.purpose}</td><td>{stageName.get(l.stageId) ?? "-"}</td><td>{l.status}</td>
                <td>{l.budgetMax ? `${l.currency} ${Number(l.budgetMax).toLocaleString("en-US")}` : "-"}</td>
                <td><Link className="btn-ghost text-xs" href={`/leads/${l.id}`}>Open</Link></td>
              </tr>
            ))}
            {leads.length === 0 && <tr><td colSpan={6} className="muted">No leads visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
