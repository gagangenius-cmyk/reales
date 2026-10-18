import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listDeals } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";

export const metadata = { title: "Deals | Reales CRM" };

const money = (v: unknown, c = "AED") => `${c} ${Number(v).toLocaleString("en-US")}`;
const tone = (s: string) => (s === "closed" ? "badge-ok" : s === "cancelled" || s === "lost" ? "badge-gray" : "");

export default async function Deals({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "deal.read")) return <NoAccess />;
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const all: any[] = await listDeals(getSequelize(), ctx, { limit: 200, offset: 0 });
  const filtered = sp.status ? all.filter((d) => d.status === sp.status) : all;
  const PAGE = 25;
  const deals = filtered.slice((page - 1) * PAGE, page * PAGE);
  const open = all.filter((d) => d.status === "open");
  const closed = all.filter((d) => d.status === "closed" || d.stage === "closed");
  const sum = (xs: any[]) => xs.reduce((a, d) => a + Number(d.amount ?? 0), 0);
  const statuses = [...new Set(all.map((d) => d.status as string))];
  const qs = (n: number) => `?${new URLSearchParams({ ...(sp.status ? { status: sp.status } : {}), page: String(n) })}`;
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Deals</h1><p className="muted text-sm">From offer to closing. A closed deal calculates its commission.</p></div></div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="card stat"><span className="muted text-xs">Total deals</span><b>{all.length}</b></div>
        <div className="card stat"><span className="muted text-xs">Open</span><b>{open.length}</b></div>
        <div className="card stat"><span className="muted text-xs">Open pipeline</span><b className="text-xl">{money(sum(open))}</b></div>
        <div className="card stat"><span className="muted text-xs">Closed value</span><b className="text-xl">{money(sum(closed))}</b></div>
      </div>
      {statuses.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Status filter">
          <Link className={!sp.status ? "btn" : "btn-ghost"} href="/deals">All</Link>
          {statuses.map((s) => <Link key={s} className={sp.status === s ? "btn" : "btn-ghost"} href={`/deals?status=${s}`}>{s}</Link>)}
        </nav>
      )}
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr><th>Created</th><th>Type</th><th>Stage</th><th>Status</th><th>Amount</th><th /></tr></thead>
          <tbody>
            {deals.map((d) => (
              <tr key={d.id}>
                <td>{new Date(d.createdAt).toISOString().slice(0, 10)}</td><td><span className="badge badge-gray">{d.dealType}</span></td><td>{String(d.stage).replace(/_/g, " ")}</td><td><span className={`badge ${tone(d.status)}`}>{d.status}</span></td>
                <td className="font-medium">{money(d.amount, d.currency)}</td>
                <td className="text-right"><Link className="btn-ghost text-xs" href={`/deals/${d.id}`}>Open</Link></td>
              </tr>
            ))}
            {deals.length === 0 && <tr><td colSpan={6} className="muted">No deals visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
      {filtered.length > PAGE && (
        <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="muted">Page {page} of {Math.ceil(filtered.length / PAGE)}</span>
          <div className="flex gap-2">{page > 1 && <Link className="btn-ghost" href={qs(page - 1)}>Previous</Link>}{page * PAGE < filtered.length && <Link className="btn-ghost" href={qs(page + 1)}>Next</Link>}</div>
        </nav>
      )}
    </section>
  );
}
