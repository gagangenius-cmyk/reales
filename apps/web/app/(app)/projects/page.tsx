import { getSequelize } from "@reales/database";
import { listProjects } from "@reales/domain";
import { can } from "@reales/rbac";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { NewProjectForm } from "./new-project-form";

export const metadata = { title: "Projects | Reales CRM" };

export default async function Projects() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "project.read")) return <NoAccess />;
  const projects: any[] = await listProjects(getSequelize(), ctx);
  return (
    <section>
      <h1 className="text-2xl font-semibold">Projects and portfolios</h1>
      {can(ctx, "project.manage") && <NewProjectForm />}
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>Status</th></tr></thead>
          <tbody>
            {projects.map((p) => <tr key={p.id}><td>{p.code}</td><td>{p.name}</td><td>{p.kind}</td><td>{p.status}</td></tr>)}
            {projects.length === 0 && <tr><td colSpan={4} className="muted">No projects yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
