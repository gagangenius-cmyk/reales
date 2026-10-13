import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getWorkflow, listRuns } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { WorkflowEditor } from "./editor";

export const metadata = { title: "Workflow | Reales CRM" };

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "workflow.read")) return <NoAccess />;
  const { id } = await params;
  const sq = getSequelize();
  let wf: any;
  try { wf = await getWorkflow(sq, ctx, id); } catch {
    return <section><h1 className="text-2xl font-semibold">Workflow not found</h1><Link className="btn-ghost mt-3 inline-block" href="/automation">Back</Link></section>;
  }
  const runs: any[] = await listRuns(sq, ctx, id);
  const canEdit = hasPermission(ctx, "workflow.manage");
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Link className="muted text-sm" href="/automation">Back to automation</Link>
        <h1 className="text-2xl font-semibold">{wf.name}</h1>
        <p className="muted text-sm">Status {wf.status} - version {wf.currentVersion}</p>
      </div>
      {canEdit ? <WorkflowEditor id={wf.id} initial={wf.draftGraph ?? { nodes: [], edges: [] }} status={wf.status} /> : <p className="muted">You can view but not edit workflows.</p>}
      <div className="card overflow-x-auto p-2">
        <h2 className="p-2 font-semibold">Recent runs</h2>
        <table className="t">
          <thead><tr><th>Started</th><th>Status</th><th>Steps</th><th>Error</th></tr></thead>
          <tbody>
            {runs.map((r) => <tr key={r.id}><td>{new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " ")}</td><td>{r.status}</td><td>{r.stepsExecuted}</td><td>{r.error ?? "-"}</td></tr>)}
            {runs.length === 0 && <tr><td colSpan={4} className="muted">No runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
