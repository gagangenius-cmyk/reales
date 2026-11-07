import { getSequelize } from "@reales/database";
import { listClaimBatches, listClaimCandidates } from "@reales/domain";
import { widestScope } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NewBatch } from "./claims-client";
import { ClaimsTable } from "./claims-table";

export const metadata = { title: "Commission claims | Reales CRM" };

export default async function Claims() {
  const ctx = await requireContext();
  const sq = getSequelize();
  const canBuild = widestScope(ctx, "claim.create") === "tenant";
  const [batches, candidates]: [any[], any[]] = await Promise.all([widestScope(ctx, "claim.read") === "tenant" ? (listClaimBatches(sq, ctx) as Promise<any[]>) : Promise.resolve([]), canBuild ? (listClaimCandidates(sq, ctx) as Promise<any[]>) : Promise.resolve([])]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Commission claims</h1><p className="muted text-sm">Batch approved commissions, verify them with evidence, approve, schedule and release payment. Every stage is done by a different person.</p></div>{canBuild && <NewBatch candidates={candidates} />}</div>
      <div className="card p-4"><ClaimsTable rows={batches} /></div>
    </section>
  );
}
