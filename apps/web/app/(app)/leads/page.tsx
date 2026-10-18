import Link from "next/link";
import { getSequelize } from "@reales/database";
import { DEFAULT_SOURCES, listAssignableUsers, listContacts, listLeads, listPipelines, listProjects } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { NewLeadDrawer } from "./new-lead-drawer";

export const metadata = { title: "Leads | Reales CRM" };

const PAGE = 25;

export default async function Leads({ searchParams }: { searchParams: Promise<{ status?: string; mine?: string; page?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "lead.read")) return <NoAccess />;
  const sp = await searchParams;
  const status = ["open", "won", "lost"].includes(sp.status ?? "") ? sp.status : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const sq = getSequelize();
  const readContacts = hasPermission(ctx, "contact.read");
  const [leads, pipelines, contacts, projects, assignable] = await Promise.all([
    listLeads(sq, ctx, { limit: PAGE + 1, offset: (page - 1) * PAGE, status, mine: sp.mine === "true" }) as Promise<any[]>,
    listPipelines(sq, ctx) as Promise<any[]>,
    readContacts ? (listContacts(sq, ctx, { limit: 500, offset: 0 }) as Promise<any[]>) : Promise.resolve([]),
    hasPermission(ctx, "project.read") ? (listProjects(sq, ctx) as Promise<any[]>) : Promise.resolve([]),
    can(ctx, "lead.create") ? listAssignableUsers(sq, ctx) : Promise.resolve([]),
  ]);
  const defaultPipeline = pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const openStages = (defaultPipeline?.stages ?? []).filter((s: any) => s.kind === "open").map((s: any) => ({ id: s.id, name: s.name }));
  const userName = new Map<string, string>(assignable.map((u) => [u.id, u.email]));
  const campaigns = [...new Set(leads.map((l) => l.campaign).filter(Boolean))] as string[];
  const contactName = new Map<string, string>(contacts.map((c) => [c.id, [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.phoneE164 || "Unnamed"]));
  const hasNext = leads.length > PAGE;
  leads.splice(PAGE);
  const qs = (n: number) => `?${new URLSearchParams({ ...(status ? { status } : {}), ...(sp.mine ? { mine: sp.mine } : {}), page: String(n) })}`;
  const stageName = new Map<string, string>(pipelines.flatMap((p) => p.stages.map((s: any) => [s.id, s.name] as [string, string])));
  return (
    <section>
      <div className="flex items-center justify-between"><h1 className="text-2xl font-semibold">Leads</h1>{can(ctx, "lead.create") && <NewLeadDrawer sources={DEFAULT_SOURCES.map((s) => ({ code: s.code, name: s.name }))} projects={projects.map((p) => ({ id: p.id, name: p.name }))} canReadContacts={readContacts} stages={openStages} users={assignable.map((u) => ({ id: u.id, email: u.email }))} campaigns={campaigns} meId={ctx.userId} />}</div>
      <nav className="mt-3 flex gap-2 text-sm" aria-label="Lead filters">
        <Link className="btn-ghost" href="/leads">All</Link>
        <Link className="btn-ghost" href="/leads?status=open">Open</Link>
        <Link className="btn-ghost" href="/leads?status=won">Won</Link>
        <Link className="btn-ghost" href="/leads?status=lost">Lost</Link>
        <Link className="btn-ghost" href="/leads?mine=true">Mine</Link>
      </nav>
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Contact</th><th>Received</th><th>Purpose</th><th>Stage</th><th>Status</th><th>Campaign</th><th>Assigned to</th><th>Follow-up</th><th>Budget (max)</th><th></th></tr></thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td>{contactName.get(l.contactId) ?? "-"}</td>
                <td>{new Date(l.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                <td>{l.isHot ? <span className="err" title="Hot lead">&#9650; Hot </span> : null}{l.purpose}</td><td>{stageName.get(l.stageId) ?? "-"}</td><td>{l.status}</td>
                <td>{l.campaign ?? "-"}</td><td>{l.assignedUserId ? (userName.get(l.assignedUserId) ?? "Assigned") : "Unassigned"}</td><td className={l.nextFollowUpAt && new Date(l.nextFollowUpAt) < new Date() && l.status === "open" ? "err" : ""}>{l.nextFollowUpAt ? new Date(l.nextFollowUpAt).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) : "-"}</td>
                <td>{l.budgetMax ? `${l.currency} ${Number(l.budgetMax).toLocaleString("en-US")}` : "-"}</td>
                <td><Link className="btn-ghost text-xs" href={`/leads/${l.id}`}>Open</Link></td>
              </tr>
            ))}
            {leads.length === 0 && <tr><td colSpan={10} className="muted">No leads visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
      {(page > 1 || hasNext) && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="muted">Page {page}</span>
          <div className="flex gap-2">{page > 1 && <Link className="btn-ghost" href={qs(page - 1)}>Previous</Link>}{hasNext && <Link className="btn-ghost" href={qs(page + 1)}>Next</Link>}</div>
        </nav>
      )}
    </section>
  );
}
