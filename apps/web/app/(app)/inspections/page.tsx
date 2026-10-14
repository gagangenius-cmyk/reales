import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listInspectionTemplates, listInspections, listUnits, listUsers } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { ScheduleForm, TemplateForm } from "./inspection-forms";

export const metadata = { title: "Inspections | Reales CRM" };

export default async function Inspections() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "inspection.read")) return <NoAccess />;
  const sq = getSequelize();
  const manage = hasPermission(ctx, "inspection.manage");
  const [list, templates, units, users] = await Promise.all([
    listInspections(sq, ctx, { limit: 100, offset: 0 }) as Promise<any[]>,
    manage ? (listInspectionTemplates(sq, ctx) as Promise<any[]>) : Promise.resolve([]),
    manage ? ((listUnits(sq, ctx, { limit: 200, offset: 0 }).catch(() => [])) as Promise<any[]>) : Promise.resolve([]),
    manage ? ((listUsers(sq, ctx, { limit: 200, offset: 0 }).catch(() => [])) as Promise<any[]>) : Promise.resolve([]),
  ]);
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Inspections</h1>
      {manage && <TemplateForm />}
      {manage && templates.length > 0 && units.length > 0 && (
        <ScheduleForm templates={templates.map((t) => ({ id: t.id, label: `${t.name} (${t.kind})`, kind: t.kind }))} units={units.map((u) => ({ id: u.id, label: `Unit ${u.unitNumber}` }))} inspectors={users.filter((u) => u.status === "active").map((u) => ({ id: u.id, label: u.email }))} />
      )}
      <div className="card overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Kind</th><th>Status</th><th>Scheduled</th><th>Version</th><th /></tr></thead>
          <tbody>
            {list.map((i) => <tr key={i.id}><td>{String(i.kind).replace("_", "-")}</td><td>{i.status}</td><td>{i.scheduledFor ? new Date(i.scheduledFor).toISOString().slice(0, 16).replace("T", " ") : "-"}</td><td>{i.version}</td><td><Link className="btn-ghost text-sm" href={`/inspections/${i.id}`}>Open</Link></td></tr>)}
            {list.length === 0 && <tr><td colSpan={5} className="muted">No inspections visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
