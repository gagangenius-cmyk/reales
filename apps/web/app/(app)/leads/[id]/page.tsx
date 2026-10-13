import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getLead, listPipelines } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { LeadActions } from "./lead-actions";

export const metadata = { title: "Lead | Reales CRM" };

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "lead.read")) return <NoAccess />;
  const { id } = await params;
  const sq = getSequelize();
  let lead: any;
  try {
    lead = await getLead(sq, ctx, id);
  } catch {
    return <section><h1 className="text-2xl font-semibold">Lead not found</h1><Link className="btn-ghost mt-3 inline-block" href="/leads">Back to leads</Link></section>;
  }
  const [pipeline] = (await listPipelines(sq, ctx)) as any[];
  const stages: any[] = (pipeline?.stages ?? []).filter((s: any) => s.pipelineId === lead.pipelineId);
  const name = new Map(stages.map((s) => [s.id, s.name]));
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Link className="muted text-sm" href="/leads">Back to leads</Link>
        <h1 className="text-2xl font-semibold">Lead - {lead.purpose}</h1>
        <p className="muted text-sm">Status {lead.status} - stage {name.get(lead.stageId) ?? "-"}{lead.lostReason ? ` - lost: ${lead.lostReason}` : ""}</p>
      </div>
      <LeadActions leadId={lead.id} stages={stages.map((s) => ({ key: s.key, name: s.name }))} currentStageId={lead.stageId} stageKeyById={Object.fromEntries(stages.map((s) => [s.id, s.key]))} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-4">
          <h2 className="font-semibold">Stage history</h2>
          <ol className="mt-2 space-y-1 text-sm">
            {lead.stageEvents.map((e: any) => (
              <li key={e.id}>{new Date(e.createdAt).toISOString().slice(0, 16).replace("T", " ")} - {name.get(e.toStageId) ?? "?"}{e.reason ? ` (${e.reason})` : ""}</li>
            ))}
          </ol>
        </div>
        <div className="card p-4">
          <h2 className="font-semibold">Assignment history</h2>
          <ol className="mt-2 space-y-1 text-sm">
            {lead.assignments.map((a: any) => (
              <li key={a.id}>{a.method}: {a.assignedUserId ? "assigned" : "unassigned"}{a.reason ? ` - ${a.reason}` : ""}</li>
            ))}
          </ol>
        </div>
      </div>
      <div className="card p-4">
        <h2 className="font-semibold">Activity</h2>
        <ul className="mt-2 space-y-2 text-sm">
          {lead.activities.map((a: any) => (
            <li key={a.id}><span className="muted">{new Date(a.occurredAt).toISOString().slice(0, 16).replace("T", " ")} {a.kind}</span><br />{a.summary}</li>
          ))}
          {lead.activities.length === 0 && <li className="muted">No activity yet.</li>}
        </ul>
      </div>
    </section>
  );
}
