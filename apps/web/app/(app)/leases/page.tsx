import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listLeases } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";

export const metadata = { title: "Leases | Reales CRM" };

const money = (v: unknown, c = "AED") => `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export default async function Leases() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "lease.read")) return <NoAccess />;
  const leases: any[] = await listLeases(getSequelize(), ctx, { limit: 100, offset: 0 });
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Leases</h1>
      <div className="card overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Term</th><th>Status</th><th>Annual rent</th><th>Instalments</th><th>Registration</th><th /></tr></thead>
          <tbody>
            {leases.map((l) => (
              <tr key={l.id}>
                <td>{l.startsOn} to {l.endsOn}</td><td>{l.status}</td><td>{money(l.annualRent, l.currency)}</td><td>{l.installments}</td><td>{l.registrationRef ?? "-"}</td>
                <td><Link className="btn-ghost text-sm" href={`/leases/${l.id}`}>Open</Link></td>
              </tr>
            ))}
            {leases.length === 0 && <tr><td colSpan={6} className="muted">No leases visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
