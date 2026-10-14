import { getSequelize } from "@reales/database";
import { listTickets, listUnits, listVendors, slaReport } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { NewTicketForm } from "./new-ticket-form";

export const metadata = { title: "Maintenance | Reales CRM" };

const stamp = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 16).replace("T", " ") : "-");

export default async function Maintenance() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "maintenance.read")) return <NoAccess />;
  const sq = getSequelize();
  const canLog = hasPermission(ctx, "maintenance.manage");
  const units: any[] = canLog ? ((await listUnits(sq, ctx, { limit: 200, offset: 0 }).catch(() => [])) as any[]) : [];
  const [tickets, vendors, sla] = await Promise.all([listTickets(sq, ctx, { limit: 100, offset: 0 }) as Promise<any[]>, listVendors(sq, ctx) as Promise<any[]>, slaReport(sq, ctx)]);
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Maintenance</h1>
      {canLog && units.length > 0 && <NewTicketForm units={units.map((u) => ({ id: u.id, label: `Unit ${u.unitNumber}` }))} />}
      <div className="card overflow-x-auto p-2">
        <h2 className="p-2 font-semibold">SLA by priority</h2>
        <table className="t">
          <thead><tr><th>Priority</th><th>Tickets</th><th>Met</th><th>Breached</th></tr></thead>
          <tbody>
            {sla.map((r) => <tr key={r.priority}><td>{r.priority}</td><td>{r.total}</td><td>{r.met}</td><td>{r.breached}</td></tr>)}
            {sla.length === 0 && <tr><td colSpan={4} className="muted">No tickets yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card overflow-x-auto p-2">
        <h2 className="p-2 font-semibold">Tickets (soonest SLA first)</h2>
        <table className="t">
          <thead><tr><th>Title</th><th>Category</th><th>Priority</th><th>Status</th><th>SLA due</th><th>Breached</th></tr></thead>
          <tbody>
            {tickets.map((t) => <tr key={t.id}><td>{t.title}</td><td>{t.category}</td><td>{t.priority}</td><td>{t.status}</td><td>{stamp(t.slaDueAt)}</td><td>{t.slaBreachedAt ? "yes" : "no"}</td></tr>)}
            {tickets.length === 0 && <tr><td colSpan={6} className="muted">No tickets visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card overflow-x-auto p-2">
        <h2 className="p-2 font-semibold">Vendors</h2>
        <table className="t">
          <thead><tr><th>Name</th><th>Categories</th><th>Licence expires</th><th>Status</th></tr></thead>
          <tbody>
            {vendors.map((v) => <tr key={v.id}><td>{v.name}</td><td>{(v.categories ?? []).join(", ")}</td><td>{v.licenceExpiresOn ?? "-"}</td><td>{v.status}</td></tr>)}
            {vendors.length === 0 && <tr><td colSpan={4} className="muted">No vendors.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
