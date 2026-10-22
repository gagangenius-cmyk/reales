import Link from "next/link";
import { getSequelize } from "@reales/database";
import { DEFAULT_SOURCES, listAssignableUsers, listContacts, listLeads, listPipelines, listProjects } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { NewLeadDrawer } from "./new-lead-drawer";
import { LeadBoard, LeadsTable, type LeadRow } from "./lead-views";

export const metadata = { title: "Leads | Reales CRM" };

const PAGE = 25;
type SP = { status?: string; mine?: string; page?: string; view?: string };

export default async function Leads({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "lead.read")) return <NoAccess />;
  const sp = await searchParams;
  const board = sp.view === "board";
  const status = ["open", "won", "lost"].includes(sp.status ?? "") ? sp.status : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const sq = getSequelize();
  const readContacts = hasPermission(ctx, "contact.read");
  const [rawLeads, pipelines, contacts, projects, assignable] = await Promise.all([
    listLeads(sq, ctx, board ? { limit: 300, offset: 0, status, mine: sp.mine === "true" } : { limit: PAGE + 1, offset: (page - 1) * PAGE, status, mine: sp.mine === "true" }) as Promise<any[]>,
    listPipelines(sq, ctx) as Promise<any[]>,
    readContacts ? (listContacts(sq, ctx, { limit: 500, offset: 0 }) as Promise<any[]>) : Promise.resolve([]),
    hasPermission(ctx, "project.read") ? (listProjects(sq, ctx) as Promise<any[]>) : Promise.resolve([]),
    can(ctx, "lead.create") || can(ctx, "lead.assign") ? listAssignableUsers(sq, ctx) : Promise.resolve([]),
  ]);
  const hasNext = !board && rawLeads.length > PAGE;
  const leads = board ? rawLeads : rawLeads.slice(0, PAGE);

  const defaultPipeline = pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const stages = ((defaultPipeline?.stages ?? []) as any[]).map((s) => ({ id: s.id as string, key: s.key as string, name: s.name as string, kind: s.kind as string }));
  const openStages = stages.filter((s) => s.kind === "open").map((s) => ({ id: s.id, name: s.name }));
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const userName = new Map<string, string>(assignable.map((u) => [u.id, u.email]));
  const campaigns = [...new Set(leads.map((l) => l.campaign).filter(Boolean))] as string[];
  const contactName = new Map<string, string>(contacts.map((c) => [c.id, [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.phoneE164 || "Unnamed"]));

  const rows: LeadRow[] = leads.map((l) => {
    const st = stageById.get(l.stageId);
    return {
      id: l.id, contactName: contactName.get(l.contactId) ?? "Contact", createdAt: new Date(l.createdAt).toISOString(), purpose: l.purpose, isHot: !!l.isHot,
      stageId: l.stageId, stageKey: st?.key ?? "", stageName: st?.name ?? "-", stageKind: st?.kind ?? "open", status: l.status, campaign: l.campaign ?? null,
      assignedUserId: l.assignedUserId ?? null, assignedTo: l.assignedUserId ? userName.get(l.assignedUserId) ?? null : null,
      followUp: l.nextFollowUpAt ? new Date(l.nextFollowUpAt).toISOString() : null, budgetMax: l.budgetMax ? Number(l.budgetMax) : null, currency: l.currency ?? "AED", tags: Array.isArray(l.tags) ? l.tags : [],
    };
  });
  const open = rows.filter((r) => r.status === "open");
  const hot = open.filter((r) => r.isHot).length;
  const overdue = open.filter((r) => r.followUp && new Date(r.followUp) < new Date()).length;
  const unassigned = open.filter((r) => !r.assignedUserId).length;

  const q = (over: Partial<SP>) => { const p = new URLSearchParams(); const m = { status, mine: sp.mine, view: sp.view, ...over }; for (const [k, v] of Object.entries(m)) if (v) p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : "?"; };
  const chip = (active: boolean) => (active ? "btn" : "btn-ghost");
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head">
        <div><h1>Leads</h1><p className="muted text-sm">{board ? "Drag cards between stages." : "Select rows for bulk actions."}</p></div>
        {can(ctx, "lead.create") && <NewLeadDrawer sources={DEFAULT_SOURCES.map((s) => ({ code: s.code, name: s.name }))} projects={projects.map((p) => ({ id: p.id, name: p.name }))} canReadContacts={readContacts} stages={openStages} users={assignable.map((u) => ({ id: u.id, email: u.email }))} campaigns={campaigns} meId={ctx.userId} />}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="card stat"><span className="muted text-xs">Open leads{board ? "" : " (this page)"}</span><b>{open.length}</b></div>
        <div className="card stat"><span className="muted text-xs">Hot</span><b className={hot ? "err" : ""}>{hot}</b></div>
        <div className="card stat"><span className="muted text-xs">Follow-ups overdue</span><b className={overdue ? "err" : ""}>{overdue}</b></div>
        <div className="card stat"><span className="muted text-xs">Unassigned</span><b>{unassigned}</b></div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Lead filters">
          <Link className={chip(!status && !sp.mine)} href={q({ status: undefined, mine: undefined, page: undefined })}>All</Link>
          {["open", "won", "lost"].map((s) => <Link key={s} className={chip(status === s)} href={q({ status: s, mine: undefined, page: undefined })}>{s[0]!.toUpperCase() + s.slice(1)}</Link>)}
          <Link className={chip(sp.mine === "true")} href={q({ mine: "true", status: undefined, page: undefined })}>Mine</Link>
        </nav>
        <nav className="inline-flex rounded-lg border p-0.5 text-sm" style={{ borderColor: "var(--border)" }} aria-label="View">
          <Link className={`rounded-md px-3 py-1.5 ${!board ? "btn" : ""}`} href={q({ view: undefined, page: undefined })}>List</Link>
          <Link className={`rounded-md px-3 py-1.5 ${board ? "btn" : ""}`} href={q({ view: "board", page: undefined })}>Board</Link>
        </nav>
      </div>
      {board
        ? <LeadBoard rows={rows} stages={stages} canMove={can(ctx, "lead.update")} />
        : <LeadsTable rows={rows} stages={stages} users={assignable.map((u) => ({ id: u.id, email: u.email }))} canAssign={can(ctx, "lead.assign")} canUpdate={can(ctx, "lead.update")} />}
      {!board && (page > 1 || hasNext) && (
        <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="muted">Page {page}</span>
          <div className="flex gap-2">{page > 1 && <Link className="btn-ghost" href={q({ page: String(page - 1) })}>Previous</Link>}{hasNext && <Link className="btn-ghost" href={q({ page: String(page + 1) })}>Next</Link>}</div>
        </nav>
      )}
    </section>
  );
}
