import Link from "next/link";
import { getSequelize } from "@reales/database";
import { DEFAULT_SOURCES, listAssignableUsers, listContacts, listPipelines, listProjects, searchLeadsAdvanced, leadStatusSummary, type LeadFilters } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { ActiveChips, Check, Field, Num, Sel, SortTh, ViewTabs, date, num, pick, qs } from "@/components/filter-bits";
import { LiveSearch } from "@/components/live-search";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { TransferLeads } from "./transfer-leads";
import { NewLeadDrawer } from "./new-lead-drawer";
import { LeadBoard, LeadsTable, type LeadRow } from "./lead-views";

export const metadata = { title: "Leads | Reales CRM" };

const PAGE = 25;
type SP = Record<string, string | undefined>;
const SORTS = ["newest", "oldest", "followup", "budget", "score", "stale"] as const;
const KEYS = ["q", "status", "mine", "stage", "purpose", "source", "campaign", "assigned", "hot", "project", "budgetMin", "budgetMax", "beds", "from", "to", "followUp", "staleDays", "tag", "language", "financing", "timeline", "pool", "minScore", "never", "sort"];

export default async function Leads({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "lead.read")) return <NoAccess />;
  const sp = await searchParams;
  const board = sp.view === "board";
  const status = pick(sp.status, ["open", "won", "lost"]);
  const page = Math.max(1, Number(sp.page) || 1);
  const sq = getSequelize();
  const readContacts = hasPermission(ctx, "contact.read");
  const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
  const filters: LeadFilters = {
    q: sp.q?.trim() || undefined, status, purpose: sp.purpose ? [sp.purpose] : undefined, stageIds: uuid(sp.stage) ? [sp.stage!] : undefined, sourceIds: uuid(sp.source) ? [sp.source!] : undefined, campaign: sp.campaign?.trim() || undefined,
    assigned: sp.mine === "true" ? "me" : sp.assigned === "me" || sp.assigned === "unassigned" || uuid(sp.assigned) ? sp.assigned : undefined, hot: sp.hot === "1" || undefined, projectId: uuid(sp.project),
    budgetMin: num(sp.budgetMin), budgetMax: num(sp.budgetMax), bedrooms: num(sp.beds), createdFrom: date(sp.from), createdTo: date(sp.to), followUp: pick(sp.followUp, ["overdue", "today", "week", "none"]), staleDays: num(sp.staleDays),
    tags: sp.tag ? [sp.tag] : undefined, language: sp.language?.trim() || undefined, financing: sp.financing || undefined, timeline: sp.timeline || undefined, inPool: sp.pool === "1" || undefined, minScore: num(sp.minScore), neverContacted: sp.never === "1" || undefined,
    sort: pick(sp.sort, SORTS) ?? "newest",
  };
  const [summary, found, pipelines, contacts, projects, assignable] = await Promise.all([
    leadStatusSummary(sq, ctx),
    searchLeadsAdvanced(sq, ctx, board ? { ...filters, limit: 300, offset: 0 } : { ...filters, limit: PAGE, offset: (page - 1) * PAGE }),
    listPipelines(sq, ctx) as Promise<any[]>,
    readContacts ? (listContacts(sq, ctx, { limit: 500, offset: 0 }) as Promise<any[]>) : Promise.resolve([]),
    hasPermission(ctx, "project.read") ? (listProjects(sq, ctx) as Promise<any[]>) : Promise.resolve([]),
    can(ctx, "lead.create") || can(ctx, "lead.assign") ? listAssignableUsers(sq, ctx) : Promise.resolve([]),
  ]);
  const rawLeads = found.rows as any[];
  const hasNext = !board && page * PAGE < found.total;
  const leads = rawLeads;

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

  const cur: SP = Object.fromEntries([...KEYS, "view"].map((k) => [k, sp[k]]));
  const q = (over: SP) => `/leads${qs({ ...cur, ...over })}` || "/leads";
  const sortHref = (s: string) => q({ sort: s, page: undefined });
  const advOn = KEYS.some((k) => !["q", "status", "mine", "sort"].includes(k) && sp[k]);
  const chips = KEYS.filter((k) => k !== "sort" && sp[k]).map((k) => ({ label: `${k}: ${sp[k]}`, href: q({ [k]: undefined, page: undefined }) }));
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
      <div className="card flex flex-col gap-3 p-4" aria-label="Lead status overview">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-semibold">Lead status at a glance</h2><span className="muted text-xs">{summary.today} new today - {summary.open} open - {summary.won} won - {summary.lost} lost</span></div>
        <div className="flex flex-wrap gap-2 text-sm">
          {summary.stages.map((st) => <Link key={st.id} href={q({ stage: st.id, status: "open", page: undefined })} className={sp.stage === st.id ? "btn" : "btn-ghost"}>{st.name} <b>{st.count}</b></Link>)}
          <Link href={q({ status: "won", stage: undefined, page: undefined })} className={status === "won" ? "btn" : "btn-ghost"}>Won <b>{summary.won}</b></Link>
          <Link href={q({ status: "lost", stage: undefined, page: undefined })} className={status === "lost" ? "btn" : "btn-ghost"}>Lost <b>{summary.lost}</b></Link>
        </div>
        <div className="flex flex-wrap gap-2 border-t pt-3 text-sm" style={{ borderColor: "var(--border)" }}>
          <Link href={q({ hot: "1", status: "open", page: undefined })} className="btn-ghost">Hot <b className={summary.hot ? "err" : ""}>{summary.hot}</b></Link>
          <Link href={q({ followUp: "overdue", status: "open", page: undefined })} className="btn-ghost">Follow-up overdue <b className={summary.overdue ? "err" : ""}>{summary.overdue}</b></Link>
          <Link href={q({ assigned: "unassigned", status: "open", page: undefined })} className="btn-ghost">Unassigned <b>{summary.unassigned}</b></Link>
          <Link href={q({ never: "1", status: "open", page: undefined })} className="btn-ghost">Never contacted <b>{summary.neverContacted}</b></Link>
          <Link href={q({ pool: "1", status: "open", page: undefined })} className="btn-ghost">In a pool <b>{summary.inPool}</b></Link>
        </div>
      </div>
      <form className="card flex flex-col gap-3 p-3" action="/leads">
        {sp.view && <input type="hidden" name="view" value={sp.view} />}{filters.sort !== "newest" && <input type="hidden" name="sort" value={filters.sort} />}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Search" wide><LiveSearch placeholder="Name, company, e-mail or phone" /></Field>
          <Field label="Status"><Sel name="status" value={status} any="All" options={["open", "won", "lost"]} /></Field>
          <Field label="Stage"><Sel name="stage" value={sp.stage} options={stages.map((s): [string, string] => [s.id, s.name])} /></Field>
          <button className="btn">Filter</button>{chips.length > 0 && <Link className="btn-ghost" href={sp.view ? `/leads?view=${sp.view}` : "/leads"}>Clear all</Link>}
        </div>
        <details open={advOn}>
          <summary className="cursor-pointer text-sm font-medium">Advanced filters</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Purpose"><Sel name="purpose" value={sp.purpose} options={["buy", "rent", "invest", "sell", "lease_out"]} /></Field>
            <Field label="Assigned to"><Sel name="assigned" value={sp.assigned} options={[["me", "Me"], ["unassigned", "Unassigned"], ...assignable.map((u): [string, string] => [u.id, u.email])]} /></Field>
            <Field label="Project"><Sel name="project" value={sp.project} options={projects.map((p): [string, string] => [p.id, p.name])} /></Field>
            <Field label="Campaign"><input className="input" name="campaign" defaultValue={sp.campaign ?? ""} /></Field>
            <Field label="Budget from (AED)"><Num name="budgetMin" value={filters.budgetMin} /></Field>
            <Field label="Budget to (AED)"><Num name="budgetMax" value={filters.budgetMax} /></Field>
            <Field label="Bedrooms"><Num name="beds" value={filters.bedrooms} /></Field>
            <Field label="Min score"><Num name="minScore" value={filters.minScore} /></Field>
            <Field label="Received from"><input className="input" type="date" name="from" defaultValue={sp.from ?? ""} /></Field>
            <Field label="Received to"><input className="input" type="date" name="to" defaultValue={sp.to ?? ""} /></Field>
            <Field label="Follow-up"><Sel name="followUp" value={filters.followUp} options={[["overdue", "Overdue"], ["today", "Today"], ["week", "Next 7 days"], ["none", "None set"]]} /></Field>
            <Field label="No contact for (days)"><Num name="staleDays" value={filters.staleDays} /></Field>
            <Field label="Financing"><input className="input" name="financing" defaultValue={sp.financing ?? ""} placeholder="cash, mortgage..." /></Field>
            <Field label="Purchase timeline"><input className="input" name="timeline" defaultValue={sp.timeline ?? ""} /></Field>
            <Field label="Language"><input className="input" name="language" defaultValue={sp.language ?? ""} placeholder="en, ar..." /></Field>
            <Field label="Tag"><input className="input" name="tag" defaultValue={sp.tag ?? ""} /></Field>
            <div className="flex flex-col justify-end gap-2 sm:col-span-2 lg:col-span-4 sm:flex-row sm:gap-6"><Check name="hot" checked={!!filters.hot} label="Hot only" /><Check name="never" checked={!!filters.neverContacted} label="Never contacted" /><Check name="pool" checked={!!filters.inPool} label="In a lead pool" /></div>
          </div>
        </details>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Quick filters">
          <Link className={chip(!status && !sp.mine)} href={q({ status: undefined, mine: undefined, page: undefined })}>All</Link>
          {["open", "won", "lost"].map((s) => <Link key={s} className={chip(status === s)} href={q({ status: s, mine: undefined, page: undefined })}>{s[0]!.toUpperCase() + s.slice(1)}</Link>)}
          <Link className={chip(sp.mine === "true")} href={q({ mine: "true", status: undefined, page: undefined })}>Mine</Link>
        </nav>
        <nav className="inline-flex rounded-lg border p-0.5 text-sm" style={{ borderColor: "var(--border)" }} aria-label="View">
          <Link className="rounded-md px-3 py-1.5" href="/leads/overview">Overview</Link>
          <Link className={`rounded-md px-3 py-1.5 ${!board ? "btn" : ""}`} href={q({ view: undefined, page: undefined })}>List</Link>
          <Link className={`rounded-md px-3 py-1.5 ${board ? "btn" : ""}`} href={q({ view: "board", page: undefined })}>Board</Link>
        </nav>
      </div>
      {can(ctx, "lead.assign") && <TransferLeads users={assignable.map((u) => ({ id: u.id, email: u.email }))} />}
      <ActiveChips chips={chips} />
      {board
        ? <LeadBoard rows={rows} stages={stages} canMove={can(ctx, "lead.update")} />
        : <LeadsTable rows={rows} stages={stages} users={assignable.map((u) => ({ id: u.id, email: u.email }))} canAssign={can(ctx, "lead.assign")} canUpdate={can(ctx, "lead.update")} sortLinks={{ sort: filters.sort ?? "newest", received: [sortHref("oldest"), sortHref("newest")], followUp: [sortHref("followup"), sortHref("followup")], budget: [sortHref("budget"), sortHref("budget")], contacted: [sortHref("stale"), sortHref("stale")] }} />}
      {!board && (page > 1 || hasNext) && (
        <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="muted">Page {page}</span>
          <div className="flex gap-2">{page > 1 && <Link className="btn-ghost" href={q({ page: String(page - 1) })}>Previous</Link>}{hasNext && <Link className="btn-ghost" href={q({ page: String(page + 1) })}>Next</Link>}</div>
        </nav>
      )}
    </section>
  );
}
