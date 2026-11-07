import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listClaimBatches, listClaimCandidates } from "@reales/domain";
import { widestScope } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NewBatch } from "./claims-client";

export const metadata = { title: "Commission claims | Reales CRM" };

const badge = (s: string) => (s === "released" ? "badge-ok" : ["rejected", "cancelled", "reversed"].includes(s) ? "badge-danger" : "badge-warn");

export default async function Claims() {
  const ctx = await requireContext();
  const sq = getSequelize();
  const canBuild = widestScope(ctx, "claim.create") === "tenant";
  const [batches, candidates]: [any[], any[]] = await Promise.all([widestScope(ctx, "claim.read") === "tenant" ? (listClaimBatches(sq, ctx) as Promise<any[]>) : Promise.resolve([]), canBuild ? (listClaimCandidates(sq, ctx) as Promise<any[]>) : Promise.resolve([])]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Commission claims</h1><p className="muted text-sm">Batch approved commissions, verify them with evidence, approve, schedule and release payment. Every stage is done by a different person.</p></div>{canBuild && <NewBatch candidates={candidates} />}</div>
      <div className="card overflow-x-auto p-0">
        <table className="t w-full text-sm">
          <thead><tr><th>Batch</th><th>Status</th><th>Items</th><th>Amount</th><th>VAT</th><th>Release date</th><th>Created</th></tr></thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td><Link className="underline-offset-2 hover:underline" href={`/claims/${b.id}`}>#{b.number} {b.title}</Link></td>
                <td><span className={`badge ${badge(b.status)}`}>{b.status}</span></td><td>{b.itemCount}</td>
                <td>{b.currency ?? ""} {Number(b.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td><td>{Number(b.vatAmount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                <td>{b.scheduledFor ?? "-"}</td><td>{new Date(b.createdAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric" })}</td>
              </tr>
            ))}
            {batches.length === 0 && <tr><td colSpan={7} className="muted py-4 text-center">No claim batches yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
