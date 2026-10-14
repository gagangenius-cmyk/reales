import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getTicket, listVendors } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { TicketActions } from "./ticket-actions";

export const metadata = { title: "Ticket | Reales CRM" };

const stamp = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 16).replace("T", " ") : "-");

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "maintenance.read")) return <NoAccess />;
  const { id } = await params;
  const sq = getSequelize();
  let t: any;
  try { t = await getTicket(sq, ctx, id); } catch {
    return <section><h1 className="text-2xl font-semibold">Ticket not found</h1><Link className="btn-ghost mt-3 inline-block" href="/maintenance">Back</Link></section>;
  }
  const vendors: any[] = hasPermission(ctx, "maintenance.manage") ? ((await listVendors(sq, ctx).catch(() => [])) as any[]) : [];
  const vname = new Map(vendors.map((v) => [v.id, v.name]));
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Link className="muted text-sm" href="/maintenance">Back to maintenance</Link>
        <h1 className="text-2xl font-semibold">{t.title}</h1>
        <p className="muted text-sm">{t.category} - priority {t.priority} - status <strong>{t.status}</strong> - SLA due {stamp(t.slaDueAt)}{t.slaBreachedAt ? " (breached)" : ""}</p>
        {t.description && <p className="mt-2 text-sm">{t.description}</p>}
      </div>
      <TicketActions ticket={{ id: t.id, status: t.status, quotations: t.quotations, workOrders: t.workOrders }} vendors={vendors.filter((v) => v.status === "active").map((v) => ({ id: v.id, name: v.name }))}
        canManage={hasPermission(ctx, "maintenance.manage")} canApprove={hasPermission(ctx, "maintenance.approve")} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card overflow-x-auto p-2">
          <h2 className="p-2 font-semibold">Quotations</h2>
          <table className="t"><thead><tr><th>Vendor</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>{t.quotations.map((q: any) => <tr key={q.id}><td>{vname.get(q.vendorId) ?? String(q.vendorId).slice(0, 8)}</td><td>{q.currency} {Number(q.amount).toLocaleString("en-US")}</td><td>{q.status}</td></tr>)}
              {t.quotations.length === 0 && <tr><td colSpan={3} className="muted">None yet.</td></tr>}</tbody></table>
        </div>
        <div className="card overflow-x-auto p-2">
          <h2 className="p-2 font-semibold">Work orders</h2>
          <table className="t"><thead><tr><th>Vendor</th><th>Quoted</th><th>Final</th><th>Status</th></tr></thead>
            <tbody>{t.workOrders.map((w: any) => <tr key={w.id}><td>{vname.get(w.vendorId) ?? String(w.vendorId).slice(0, 8)}</td><td>{w.quotedAmount ?? "-"}</td><td>{w.finalCost ?? "-"}</td><td>{w.status}</td></tr>)}
              {t.workOrders.length === 0 && <tr><td colSpan={4} className="muted">None yet.</td></tr>}</tbody></table>
        </div>
      </div>
      <div className="card p-4">
        <h2 className="font-semibold">History</h2>
        <ol className="mt-2 space-y-1 text-sm">{t.events.map((e: any) => <li key={e.id}><span className="muted">{stamp(e.createdAt)}</span> {String(e.type).replace(/_/g, " ")}</li>)}</ol>
      </div>
    </section>
  );
}
