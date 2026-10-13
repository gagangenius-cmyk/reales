import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getLease } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";

export const metadata = { title: "Lease | Reales CRM" };

const money = (v: unknown, c = "AED") => `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export default async function LeasePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "lease.read")) return <NoAccess />;
  const { id } = await params;
  let l: any;
  try { l = await getLease(getSequelize(), ctx, id); } catch {
    return <section><h1 className="text-2xl font-semibold">Lease not found</h1><Link className="btn-ghost mt-3 inline-block" href="/leases">Back</Link></section>;
  }
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Link className="muted text-sm" href="/leases">Back to leases</Link>
        <h1 className="text-2xl font-semibold">Lease {l.startsOn} to {l.endsOn}</h1>
        <p className="muted text-sm">Status {l.status} - {money(l.annualRent, l.currency)} per year - registration {l.registrationRef ?? "not recorded"}</p>
      </div>
      <div className="card overflow-x-auto p-2">
        <h2 className="p-2 font-semibold">Rent schedule (paid {money(l.paidTotal, l.currency)} of {money(l.scheduleTotal, l.currency)})</h2>
        <table className="t">
          <thead><tr><th>#</th><th>Due</th><th>Amount</th><th>Paid</th><th>Status</th></tr></thead>
          <tbody>{l.schedule.map((r: any) => <tr key={r.id}><td>{r.seq}</td><td>{r.dueDate}</td><td>{money(r.amount, l.currency)}</td><td>{money(r.paidAmount, l.currency)}</td><td>{r.status}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="card p-4">
        <h2 className="font-semibold">Parties</h2>
        <ul className="mt-2 text-sm">{l.parties.map((p: any) => <li key={p.id}>{p.role}: <Link className="underline" href={`/contacts/${p.contactId}`}>{p.contactId.slice(0, 8)}</Link></li>)}</ul>
      </div>
      {l.deposit && (
        <div className="card p-4">
          <h2 className="font-semibold">Security deposit</h2>
          <p className="text-sm">{money(l.deposit.amount, l.currency)} - {l.deposit.status} - currently held {money(l.deposit.held, l.currency)}</p>
          <ul className="mt-2 text-sm">{l.deposit.movements.map((m: any) => <li key={m.id}>{m.kind} {money(m.amount, l.currency)}{m.reason ? ` (${m.reason})` : ""}</li>)}</ul>
        </div>
      )}
      <p className="muted text-sm">Activation, rent recording, renewal and termination are available through the API ({hasPermission(ctx, "lease.manage") ? "you can manage this lease" : "read-only for you"}).</p>
    </section>
  );
}
