import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listWorkflows } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { NewWorkflowForm } from "./new-workflow-form";

export const metadata = { title: "Automation | Reales CRM" };

export default async function Automation() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "workflow.read")) return <NoAccess />;
  const wfs: any[] = await listWorkflows(getSequelize(), ctx);
  return (
    <section>
      <h1 className="text-2xl font-semibold">Automation</h1>
      <p className="muted text-sm">Visual workflows that react to CRM events. They act through the same rules as people: consent, permissions and audit all apply.</p>
      {hasPermission(ctx, "workflow.manage") && <NewWorkflowForm />}
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Name</th><th>Status</th><th>Version</th><th></th></tr></thead>
          <tbody>
            {wfs.map((w) => <tr key={w.id}><td>{w.name}</td><td>{w.status}</td><td>{w.currentVersion}</td><td><Link className="btn-ghost text-xs" href={`/automation/${w.id}`}>Open</Link></td></tr>)}
            {wfs.length === 0 && <tr><td colSpan={4} className="muted">No workflows yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
