import { DeleteButton } from "@/components/delete-button";
import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getContact, getLead, listPipelines, listPools, matchesForLead, nextBestActions } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { LeadActions } from "./lead-actions";
import { MatchPanel } from "./match-panel";
import { EditLeadDrawer } from "./edit-lead-drawer";
import { LogCallDrawer } from "../../calls/log-call-drawer";
import { ReleaseButton } from "../../pools/pool-client";
import { can } from "@reales/rbac";

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
  const contact: any = hasPermission(ctx, "contact.read") ? await getContact(sq, ctx, lead.contactId).catch(() => null) : null;
  const fmtDt = (v: unknown) => (v ? new Date(v as string).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) : "-");
  const money = (v: unknown) => (v ? `${lead.currency} ${Number(v).toLocaleString("en-US")}` : "-");
  const words = (v: unknown) => (Array.isArray(v) && v.length ? v.join(", ") : "-");
  const nice = (v: unknown) => (v ? String(v).replace(/_/g, " ") : "-");
  const contactName = contact ? [contact.salutation, contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.companyName || contact.email || "-" : null;
  const facts: [string, string][] = [
    ["Hot lead", lead.isHot ? "Yes" : "No"], ["Campaign", lead.campaign ?? "-"], ["Budget", `${money(lead.budgetMin)} to ${money(lead.budgetMax)}`], ["Bedrooms", lead.bedrooms ?? "-"],
    ["Areas", words(lead.preferredAreas)], ["Property types", words(lead.propertyTypes)], ["Financing", nice(lead.financing)], ["Looking to move", nice(lead.purchaseTimeline)],
    ["Next follow-up", fmtDt(lead.nextFollowUpAt)], ["Last contacted", fmtDt(lead.lastContactedAt)], ["Expected close", lead.expectedCloseDate ?? "-"], ["Tags", words(lead.tags)],
  ];
  const pools: any[] = hasPermission(ctx, "pool.claim") || hasPermission(ctx, "pool.manage") ? await listPools(sq, ctx).catch(() => []) : [];
  const actions = await nextBestActions(sq, ctx, lead.id).catch(() => []);
  const matches: any[] = hasPermission(ctx, "match.read") ? await matchesForLead(sq, ctx, lead.id).catch(() => []) : [];
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
        <Link className="muted text-sm" href="/leads">Back to leads</Link>
        <h1 className="text-2xl font-semibold">Lead - {lead.purpose}</h1>
        <p className="muted text-sm">Status {lead.status} - stage {name.get(lead.stageId) ?? "-"}{lead.lostReason ? ` - lost: ${lead.lostReason}` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        {hasPermission(ctx, "lead.assign") && <DeleteButton entity="lead" id={lead.id} name={`Lead - ${lead.purpose}`} redirectTo="/leads" small={false} />}
        {hasPermission(ctx, "call.log") && lead.status === "open" && <LogCallDrawer leadId={lead.id} contactLabel={contactName ?? undefined} label="Log call" />}
        {lead.status === "open" && (lead.assignedUserId === ctx.userId || hasPermission(ctx, "lead.assign")) && <ReleaseButton leadId={lead.id} pools={pools.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }))} />}
        {can(ctx, "lead.update", { ownerUserId: lead.assignedUserId, branchId: lead.branchId, projectId: lead.projectId }) && <EditLeadDrawer leadId={lead.id} initial={{ purpose: lead.purpose, budgetMin: lead.budgetMin ? String(Number(lead.budgetMin)) : "", budgetMax: lead.budgetMax ? String(Number(lead.budgetMax)) : "", currency: lead.currency ?? "AED", bedrooms: lead.bedrooms != null ? String(lead.bedrooms) : "", preferredAreas: (lead.preferredAreas ?? []).join(", "), language: lead.language ?? "en", isHot: !!lead.isHot, campaign: lead.campaign ?? "", financing: lead.financing ?? "", purchaseTimeline: lead.purchaseTimeline ?? "", propertyTypes: lead.propertyTypes ?? [], tags: (lead.tags ?? []).join(", "), notes: lead.notes ?? "", nextFollowUpAt: lead.nextFollowUpAt ? new Date(new Date(lead.nextFollowUpAt).getTime() + 4 * 3600000).toISOString().slice(0, 16) : "", expectedCloseDate: lead.expectedCloseDate ?? "" }} />}
        </div>
      </div>
      {actions.length > 0 && (
        <div className="card p-4" aria-label="What to do next">
          <h2 className="mb-2 font-semibold">What to do next</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {actions.map((a) => <li key={a.key} className="flex gap-3"><span className={`badge ${a.severity === "urgent" ? "badge-warn" : "badge-gray"} h-fit`}>{a.severity === "urgent" ? "Now" : a.severity === "soon" ? "Soon" : "FYI"}</span><span><b>{a.title}</b><span className="muted block">{a.detail}</span></span></li>)}
          </ul>
        </div>
      )}
      <LeadActions leadId={lead.id} stages={stages.map((s) => ({ key: s.key, name: s.name }))} currentStageId={lead.stageId} stageKeyById={Object.fromEntries(stages.map((s) => [s.id, s.key]))} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 font-semibold">Enquiry</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">{facts.map(([k, v]) => <div key={k}><dt className="muted text-xs">{k}</dt><dd className="font-medium">{v}</dd></div>)}</dl>
          {lead.notes && <p className="mt-3 whitespace-pre-wrap rounded-lg p-3 text-sm" style={{ background: "var(--card-2)" }}>{lead.notes}</p>}
        </div>
        {contact && (
          <div className="card p-4">
            <h2 className="mb-3 font-semibold">Contact</h2>
            <p className="text-lg font-semibold">{contactName}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {([["Email", contact.email], ["Phone", contact.phoneE164], ["Second phone", contact.phoneSecondary], ["WhatsApp", contact.whatsappE164], ["Nationality", contact.nationality], ["Residency", nice(contact.residency)],
                ["Job", [contact.jobTitle, contact.employer].filter(Boolean).join(" at ") || "-"], ["Location", [contact.city, contact.country].filter(Boolean).join(", ") || "-"],
                ["Prefers", `${nice(contact.preferredChannel)}${contact.preferredContactTime ? `, ${contact.preferredContactTime}` : ""}`], ["Language", contact.language], ["Tags", words(contact.tags)]] as [string, unknown][]).map(([k, v]) => <div key={k}><dt className="muted text-xs">{k}</dt><dd className="font-medium">{(v as string) || "-"}</dd></div>)}
            </dl>
            {contact.notes && <p className="mt-3 whitespace-pre-wrap rounded-lg p-3 text-sm" style={{ background: "var(--card-2)" }}>{contact.notes}</p>}
          </div>
        )}
      </div>
      {hasPermission(ctx, "match.read") && <MatchPanel leadId={lead.id} matches={matches} canManage={hasPermission(ctx, "match.manage")} />}
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
