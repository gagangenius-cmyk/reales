import { redirect } from "next/navigation";
import { getSequelize } from "@reales/database";
import { ownerPortal, portalMe, tenantPortal } from "@reales/domain";
import { requireContext } from "@/lib/page-context";
import { LogoutButton } from "../(app)/logout-button";
import { RequestForm } from "./request-form";

export const metadata = { title: "My account | Reales" };

const money = (v: unknown, c = "AED") => `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const TicketTable = ({ tickets }: { tickets: any[] }) => (
  <div className="card overflow-x-auto p-2">
    <h2 className="p-2 font-semibold">Maintenance requests</h2>
    <table className="t">
      <thead><tr><th>Request</th><th>Category</th><th>Status</th><th>Opened</th></tr></thead>
      <tbody>
        {tickets.map((t) => <tr key={t.id}><td>{t.title}</td><td>{t.category}</td><td>{t.status}</td><td>{new Date(t.createdAt).toISOString().slice(0, 10)}</td></tr>)}
        {tickets.length === 0 && <tr><td colSpan={4} className="muted">No requests.</td></tr>}
      </tbody>
    </table>
  </div>
);

export default async function Portal() {
  const ctx = await requireContext();
  const sq = getSequelize();
  let me;
  try { me = await portalMe(sq, ctx); } catch { redirect("/dashboard"); }
  const owner: any = me.kind === "owner" ? await ownerPortal(sq, ctx) : null;
  const tenant: any = me.kind === "tenant" ? await tenantPortal(sq, ctx) : null;
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-4 py-6">
      <header className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold">Welcome, {me.name}</h1><p className="muted text-sm">{me.kind === "owner" ? "Property owner portal" : "Tenant portal"}</p></div>
        <LogoutButton />
      </header>

      {owner && (
        <>
          <div className="card overflow-x-auto p-2">
            <h2 className="p-2 font-semibold">Your leases</h2>
            <table className="t">
              <thead><tr><th>Unit</th><th>Tenant</th><th>Term</th><th>Annual rent</th><th>Outstanding</th><th>Status</th></tr></thead>
              <tbody>
                {owner.leases.map((l: any) => <tr key={l.id}><td>{l.unit}</td><td>{l.tenant ?? "-"}</td><td>{l.startsOn} to {l.endsOn}</td><td>{money(l.annualRent, l.currency)}</td><td>{money(l.outstanding, l.currency)}</td><td>{l.status}</td></tr>)}
                {owner.leases.length === 0 && <tr><td colSpan={6} className="muted">No leases yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card overflow-x-auto p-2">
            <h2 className="p-2 font-semibold">Statements</h2>
            <table className="t">
              <thead><tr><th>Period</th><th>Rent collected</th><th>Fee</th><th>Maintenance</th><th>Net payable</th><th /></tr></thead>
              <tbody>
                {owner.statements.map((s: any) => <tr key={s.id}><td>{s.period}</td><td>{money(s.rentCollected, s.currency)}</td><td>{money(s.managementFee, s.currency)}</td><td>{money(s.maintenanceCost, s.currency)}</td><td>{money(s.netPayable, s.currency)}</td><td><a className="btn-ghost text-xs" href={`/api/v1/portal/statements/${s.id}/pdf`} target="_blank" rel="noopener">PDF</a></td></tr>)}
                {owner.statements.length === 0 && <tr><td colSpan={6} className="muted">No statements have been issued yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <TicketTable tickets={owner.tickets} />
        </>
      )}

      {tenant && (
        <>
          {tenant.leases.map((l: any) => (
            <div key={l.id} className="card overflow-x-auto p-2">
              <h2 className="p-2 font-semibold">{l.unit} - {l.startsOn} to {l.endsOn} ({l.status})</h2>
              <p className="muted px-2 text-sm">Annual rent {money(l.annualRent, l.currency)} - outstanding {money(l.outstanding, l.currency)}</p>
              <table className="t">
                <thead><tr><th>#</th><th>Due</th><th>Amount</th><th>Paid</th><th>Status</th></tr></thead>
                <tbody>{l.schedule.map((r: any) => <tr key={r.seq}><td>{r.seq}</td><td>{r.dueDate}</td><td>{money(r.amount, l.currency)}</td><td>{money(r.paidAmount, l.currency)}</td><td>{r.status}</td></tr>)}</tbody>
              </table>
            </div>
          ))}
          {tenant.leases.length === 0 && <p className="muted">No tenancy found on your account.</p>}
          <RequestForm leases={tenant.leases.filter((l: any) => l.status === "active").map((l: any) => ({ id: l.id, label: l.unit }))} />
          <TicketTable tickets={tenant.tickets} />
        </>
      )}
    </main>
  );
}
