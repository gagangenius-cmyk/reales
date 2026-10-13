import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listDeals } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";

export const metadata = { title: "Deals | Reales CRM" };

export default async function Deals() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "deal.read")) return <NoAccess />;
  const deals: any[] = await listDeals(getSequelize(), ctx, { limit: 100, offset: 0 });
  return (
    <section>
      <h1 className="text-2xl font-semibold">Deals</h1>
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Created</th><th>Type</th><th>Stage</th><th>Status</th><th>Amount</th><th></th></tr></thead>
          <tbody>
            {deals.map((d) => (
              <tr key={d.id}>
                <td>{new Date(d.createdAt).toISOString().slice(0, 10)}</td><td>{d.dealType}</td><td>{d.stage}</td><td>{d.status}</td>
                <td>{d.currency} {Number(d.amount).toLocaleString("en-US")}</td>
                <td><Link className="btn-ghost text-xs" href={`/deals/${d.id}`}>Open</Link></td>
              </tr>
            ))}
            {deals.length === 0 && <tr><td colSpan={6} className="muted">No deals visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
