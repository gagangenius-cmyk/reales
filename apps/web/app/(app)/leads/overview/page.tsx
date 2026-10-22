import Link from "next/link";
import { getSequelize } from "@reales/database";
import { leadsOverview, type LeadBrief } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { BarList, Columns, Donut, Funnel } from "@/components/charts";
import { ViewTabs } from "@/components/filter-bits";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";

export const metadata = { title: "Leads overview | Reales CRM" };
const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)}%`);
const aed = (n: number) => (n >= 1_000_000 ? `AED ${(n / 1_000_000).toFixed(1)}M` : `AED ${Math.round(n).toLocaleString("en-US")}`);
const dt = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short" }) : "-");

export default async function LeadsOverview() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "lead.read")) return <NoAccess />;
  const o = await leadsOverview(getSequelize(), ctx);
  const t = o.totals;
  const stat = (label: string, value: string | number, href: string, warn = false, sub?: string) => (
    <Link href={href} className="card stat transition hover:-translate-y-0.5 hover:shadow-md"><span className="muted text-xs">{label}</span><b className={warn && Number(value) > 0 ? "err" : ""}>{value}</b>{sub && <span className="muted text-xs">{sub}</span>}</Link>
  );
  const list = (title: string, rows: LeadBrief[], href: string) => (
    <div className="card p-4"><div className="mb-2 flex items-baseline justify-between"><h3 className="font-semibold">{title}</h3><Link className="text-xs" href={href}>View all</Link></div>
      {rows.length === 0 ? <p className="muted text-sm">Nothing here.</p> : <ul className="flex flex-col gap-1.5 text-sm">{rows.map((l) => <li key={l.id}><Link href={`/leads/${l.id}`}>{l.hot && <span className="err">&#9650; </span>}{l.stage} - {l.purpose}</Link><span className="muted"> {l.agent ?? "unassigned"} - {l.followUp ? `follow-up ${dt(l.followUp)}` : `received ${dt(l.created)}`}</span></li>)}</ul>}</div>
  );
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Leads overview</h1><p className="muted text-sm">Everything you can see, as of {new Date(o.generatedAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" })} Dubai time.</p></div><ViewTabs base="/leads" active="overview" extra={[{ key: "board", label: "Board", href: "/leads?view=board" }]} /></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stat("Open leads", t.open, "/leads?status=open", false, `${t.all} in total`)}
        {stat("New this week", o.trend.thisWeek, "/leads?sort=newest", false, o.trend.change === null ? "no prior week" : `${o.trend.change >= 0 ? "+" : ""}${Math.round(o.trend.change * 100)}% vs last week`)}
        {stat("Hot", t.hot, "/leads?hot=1&status=open", true)}
        {stat("Follow-ups overdue", t.overdue, "/leads?followUp=overdue&status=open", true)}
        {stat("Unassigned", t.unassigned, "/leads?assigned=unassigned&status=open", true, `${t.inPool} waiting in pools`)}
        {stat("Never contacted", t.neverContacted, "/leads?never=1&status=open", true)}
        {stat("Win rate", pct(t.winRate), "/leads?status=won", false, `${t.won} won, ${t.lost} lost`)}
        {stat("Open pipeline budget", aed(t.openBudget), "/leads?status=open&sort=budget")}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2"><h3 className="mb-2 font-semibold">Leads received, last 30 days</h3><Columns data={o.intake.slice(-30)} /></div>
        <div className="card p-4"><h3 className="mb-2 font-semibold">Speed to first response</h3>
          <p className="text-3xl font-bold">{o.response.medianMinutes === null ? "-" : o.response.medianMinutes < 60 ? `${o.response.medianMinutes} min` : `${(o.response.medianMinutes / 60).toFixed(1)} h`}</p>
          <p className="muted text-sm">median, {pct(o.response.within15)} answered within 15 minutes ({o.response.measured} measured)</p></div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4"><h3 className="mb-3 font-semibold">Open leads by stage</h3><Funnel data={o.funnel} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Where leads come from</h3><BarList data={o.sources.map((s) => ({ label: s.label, value: s.value, hint: s.won ? `${s.won} won` : undefined }))} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Purpose</h3><Donut data={o.purposes} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Open lead budgets</h3><BarList data={o.budgets} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Workload by agent (open)</h3><BarList data={o.workload} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Campaigns</h3><BarList data={o.campaigns} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Financing</h3><BarList data={o.financing} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Purchase timeline</h3><BarList data={o.timelines} /></div>
      </div>
      <h2 className="text-lg font-semibold">Needs attention</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {list("Overdue follow-ups", o.attention.overdue, "/leads?followUp=overdue&status=open&sort=followup")}
        {list("Hot leads not contacted for 2 days", o.attention.hotUntouched, "/leads?hot=1&status=open&staleDays=2&sort=stale")}
        {list("Unassigned", o.attention.unassigned, "/leads?assigned=unassigned&status=open")}
        {list("Quiet for 7+ days", o.attention.stale, "/leads?status=open&staleDays=7&sort=stale")}
      </div>
    </section>
  );
}
