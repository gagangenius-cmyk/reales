import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getDeal, getDealChecklist, listAssignableUsers, STAGE_ORDER } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { DealActions } from "./deal-actions";
import { DealChecklist } from "./deal-checklist";

export const metadata = { title: "Deal | Reales CRM" };

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "deal.read")) return <NoAccess />;
  const { id } = await params;
  let deal: any;
  try { deal = await getDeal(getSequelize(), ctx, id); } catch {
    return <section><h1 className="text-2xl font-semibold">Deal not found</h1><Link className="btn-ghost mt-3 inline-block" href="/deals">Back to deals</Link></section>;
  }
  const ref = { ownerUserId: deal.agentUserId, branchId: deal.branchId, projectId: deal.projectId };
  const checklist: any = await getDealChecklist(getSequelize(), ctx, id).catch(() => ({ items: [] }));
  const people = new Map<string, string>((await listAssignableUsers(getSequelize(), ctx).catch(() => [])).map((u: any) => [u.id, u.email]));
  const idx = STAGE_ORDER.indexOf(deal.stage);
  const next = deal.status === "open" ? STAGE_ORDER[idx + 1] : undefined;
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Link className="muted text-sm" href="/deals">Back to deals</Link>
        <h1 className="text-2xl font-semibold">{deal.dealType === "sale" ? "Sale" : "Lease"} - {deal.currency} {Number(deal.amount).toLocaleString("en-US")}</h1>
        <p className="muted text-sm">Stage {deal.stage} - status {deal.status}{deal.cancelledReason ? ` - ${deal.cancelledReason}` : ""}</p>
      </div>
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Deal stages">
        {STAGE_ORDER.map((s, i) => (
          <li key={s} className={`btn-ghost ${i === idx ? "font-semibold" : "muted"}`} aria-current={i === idx ? "step" : undefined}>{s}</li>
        ))}
      </ol>
      <DealChecklist dealId={deal.id} open={deal.status === "open"} canUpdate={can(ctx, "deal.update", ref)} canWaive={can(ctx, "deal.close", ref)} items={checklist.items.map((i: any) => ({ id: i.id, title: i.title, guidance: i.guidance ?? null, required: !!i.required, gateStage: i.gateStage, status: i.status, dueAt: i.dueAt ? new Date(i.dueAt).toISOString() : null, assigneeEmail: i.assigneeUserId ? people.get(i.assigneeUserId) ?? null : null, waivedReason: i.waivedReason ?? null, note: i.note ?? null }))} />
      {deal.status === "open" && <DealActions dealId={deal.id} nextStage={next ?? null} canUpdate={can(ctx, "deal.update", ref)} canClose={can(ctx, "deal.close", ref)} />}
      <div className="card p-4">
        <h2 className="font-semibold">Milestones</h2>
        <table className="t mt-2">
          <thead><tr><th>Milestone</th><th>Due</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {deal.milestones.map((m: any) => (
              <tr key={m.id}>
                <td>{m.title}</td><td>{m.dueDate ?? "-"}</td><td>{m.amount ? Number(m.amount).toLocaleString("en-US") : "-"}</td>
                <td>{m.status}{m.completedBy ? ` (${String(m.completedBy).split(":")[0]})` : ""}</td>
                <td>{deal.status === "open" && m.status === "pending" && can(ctx, "deal.update", ref) ? <DealActions dealId={deal.id} milestoneKey={m.key} needsReason={["deposit", "contract_signed"].includes(m.key) || String(m.key).startsWith("installment_")} canClose={can(ctx, "deal.close", ref)} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card p-4">
        <h2 className="font-semibold">History</h2>
        <ol className="mt-2 space-y-1 text-sm">
          {deal.stageEvents.map((e: any) => <li key={e.id}>{new Date(e.createdAt).toISOString().slice(0, 16).replace("T", " ")} - {e.fromStage ?? "start"} to {e.toStage}{e.reason ? ` (${e.reason})` : ""}</li>)}
        </ol>
      </div>
    </section>
  );
}
