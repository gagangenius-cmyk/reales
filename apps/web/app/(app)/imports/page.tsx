import { getSequelize } from "@reales/database";
import { listImports } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { ImportWizard } from "./import-wizard";

export const metadata = { title: "Import and export | Reales CRM" };

const EXPORTS = [["contacts", "contact.read"], ["leads", "lead.read"], ["listings", "listing.read"], ["units", "inventory.read"]] as const;

export default async function Imports() {
  const ctx = await requireContext();
  const canImport = hasPermission(ctx, "import.manage");
  const canExport = hasPermission(ctx, "export.data");
  if (!canImport && !canExport) return <NoAccess />;
  const jobs: any[] = canImport ? await listImports(getSequelize(), ctx) : [];
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Import and export</h1>
      {canImport && <ImportWizard />}
      {canExport && (
        <div className="card p-4">
          <h2 className="font-semibold">Export to CSV</h2>
          <p className="muted text-sm">Exports contain exactly the records you can see in the app. Each export is audited.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {EXPORTS.filter(([, p]) => hasPermission(ctx, p)).map(([k]) => <a key={k} className="btn-ghost text-sm" href={`/api/v1/exports/${k}`}>Download {k}</a>)}
          </div>
        </div>
      )}
      {canImport && (
        <div className="card overflow-x-auto p-2">
          <h2 className="p-2 font-semibold">Recent imports</h2>
          <table className="t">
            <thead><tr><th>Type</th><th>Status</th><th>Rows</th><th>Created</th><th>Skipped (duplicates)</th><th>Rejected</th></tr></thead>
            <tbody>
              {jobs.map((j) => <tr key={j.id}><td>{j.kind}</td><td>{j.status}</td><td>{j.totalRows}</td><td>{j.committedRows}</td><td>{j.skippedRows}</td><td>{j.errorRows}</td></tr>)}
              {jobs.length === 0 && <tr><td colSpan={6} className="muted">No imports yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
