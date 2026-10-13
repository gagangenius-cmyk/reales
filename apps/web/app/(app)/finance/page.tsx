import { getSequelize } from "@reales/database";
import { listInvoices, listPayments, listCommissions } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";

export const metadata = { title: "Finance | Reales CRM" };

const money = (v: unknown, c = "AED") => `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export default async function Finance() {
  const ctx = await requireContext();
  const finance = hasPermission(ctx, "finance.read");
  const commissions = hasPermission(ctx, "commission.read");
  if (!finance && !commissions) return <NoAccess />;
  const sq = getSequelize();
  const [invoices, payments, comm] = await Promise.all([
    finance ? (listInvoices(sq, ctx, { limit: 50, offset: 0 }) as Promise<any[]>) : Promise.resolve([]),
    finance && ctx.grants.some((g) => g.permission === "finance.read" && g.scope === "tenant") ? (listPayments(sq, ctx, { limit: 50, offset: 0 }) as Promise<any[]>) : Promise.resolve([]),
    commissions ? (listCommissions(sq, ctx, { limit: 50, offset: 0 }) as Promise<any[]>) : Promise.resolve([]),
  ]);
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Finance</h1>
      {finance && (
        <div className="card overflow-x-auto p-2">
          <h2 className="p-2 font-semibold">Invoices</h2>
          <table className="t">
            <thead><tr><th>Number</th><th>Status</th><th>Due</th><th>Total (incl. VAT)</th></tr></thead>
            <tbody>
              {invoices.map((i) => <tr key={i.id}><td>{i.number}</td><td>{i.status}</td><td>{i.dueDate ?? "-"}</td><td>{money(i.total, i.currency)}</td></tr>)}
              {invoices.length === 0 && <tr><td colSpan={4} className="muted">No invoices.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {payments.length > 0 && (
        <div className="card overflow-x-auto p-2">
          <h2 className="p-2 font-semibold">Payments</h2>
          <table className="t">
            <thead><tr><th>Received</th><th>Method</th><th>Status</th><th>Amount</th></tr></thead>
            <tbody>{payments.map((p) => <tr key={p.id}><td>{p.receivedAt ? new Date(p.receivedAt).toISOString().slice(0, 10) : "-"}</td><td>{p.method}</td><td>{p.status}</td><td>{money(p.amount, p.currency)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {commissions && (
        <div className="card overflow-x-auto p-2">
          <h2 className="p-2 font-semibold">Commissions</h2>
          <table className="t">
            <thead><tr><th>Calculated</th><th>Status</th><th>Gross</th><th>Commission</th><th>Splits</th></tr></thead>
            <tbody>
              {comm.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.calculatedAt).toISOString().slice(0, 10)}</td><td>{c.status}</td><td>{money(c.grossAmount, c.currency)}</td><td>{money(c.commissionAmount, c.currency)}</td>
                  <td>{c.splits.map((s: any) => `${s.role} ${Number(s.pct)}%`).join(", ")}</td>
                </tr>
              ))}
              {comm.length === 0 && <tr><td colSpan={5} className="muted">No commissions visible to you.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
