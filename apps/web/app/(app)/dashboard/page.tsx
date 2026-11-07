import Link from "next/link";
import { QueryTypes } from "sequelize";
import { getSequelize } from "@reales/database";
import { agentDashboard, getDashboard, isManagerView, teamDashboard, type DashboardKind, type Kpi } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { Columns, Funnel, BarList } from "@/components/charts";
import { requireContext } from "@/lib/page-context";
import { TargetBars } from "./target-bars";

export const metadata = { title: "Dashboard | Reales CRM" };

const fmtNum = (n: number) => Math.round(n).toLocaleString("en-US");
const show = (k: Kpi) => (k.format === "money" ? fmtNum(k.value) : k.format === "percent" ? `${k.value}%` : k.format === "minutes" ? `${k.value} min` : fmtNum(k.value));
const toneColor = (t?: Kpi["tone"]) => (t === "bad" ? "var(--danger)" : t === "warn" ? "var(--warn)" : t === "good" ? "var(--ok)" : "var(--accent)");

function KpiGrid({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
      {kpis.map((k) => {
        const body = (
          <div className="card stat h-full" style={{ borderLeft: `3px solid ${toneColor(k.tone)}` }}>
            <p className="muted text-xs font-medium uppercase tracking-wide">{k.label}</p>
            <b style={{ color: k.tone === "bad" ? "var(--danger)" : undefined }}>{show(k)}</b>
            {k.hint && <p className="muted mt-0.5 text-xs">{k.hint}</p>}
          </div>
        );
        return k.href ? <Link key={k.key} href={k.href} className="block transition-transform hover:-translate-y-0.5">{body}</Link> : <div key={k.key}>{body}</div>;
      })}
    </div>
  );
}

function Attention({ items }: { items: { label: string; count: number; href: string; tone: "warn" | "bad" }[] }) {
  if (!items.length) return <div className="card p-4"><h2 className="font-semibold">Needs attention</h2><p className="muted mt-1 text-sm">Nothing is overdue or at risk right now.</p></div>;
  return (
    <div className="card p-4">
      <h2 className="mb-2 font-semibold">Needs attention</h2>
      <ul className="flex flex-col gap-2 text-sm">{items.map((a) => (
        <li key={a.label}><Link href={a.href} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:opacity-80" style={{ background: `color-mix(in srgb, ${a.tone === "bad" ? "var(--danger)" : "var(--warn)"} 10%, transparent)` }}>
          <span>{a.label}</span><b style={{ color: a.tone === "bad" ? "var(--danger)" : "var(--warn)" }}>{a.count}</b></Link></li>))}</ul>
    </div>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const KIND: Record<string, string> = { viewing: "Viewing", task: "Task", followup: "Follow-up" };

function Tabs({ view }: { view: "team" | "me" }) {
  return (
    <nav className="inline-flex rounded-lg border p-0.5 text-sm" style={{ borderColor: "var(--border)" }} aria-label="Dashboard view">
      <Link href="/dashboard" className={`rounded-md px-3 py-1.5 ${view === "team" ? "btn" : ""}`} aria-current={view === "team" ? "page" : undefined}>Team</Link>
      <Link href="/dashboard?view=me" className={`rounded-md px-3 py-1.5 ${view === "me" ? "btn" : ""}`} aria-current={view === "me" ? "page" : undefined}>My day</Link>
    </nav>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const ctx = await requireContext();
  const sq = getSequelize();
  const sp = await searchParams;
  const manager = isManagerView(ctx);
  const view: "team" | "me" = manager && sp.view !== "me" ? "team" : "me";
  const hour = (new Date().getUTCHours() + 4) % 24;
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  if (view === "me") {
    const d = await agentDashboard(sq, ctx);
    return (
      <section className="flex flex-col gap-6">
        <div className="page-head"><div><h1>{greeting}</h1><p className="muted text-sm">Your day: what to do next, what is at risk, and how you are doing against target.</p></div>{manager && <Tabs view="me" />}</div>
        <KpiGrid kpis={d.kpis} />
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="card p-4 lg:col-span-2">
            <h2 className="mb-3 font-semibold">Today and overdue</h2>
            {d.agenda.length === 0 ? <p className="muted text-sm">Nothing scheduled. A good moment to work your hot leads.</p> : (
              <ul className="flex flex-col divide-y text-sm" style={{ borderColor: "var(--border)" }}>{d.agenda.map((a) => (
                <li key={`${a.kind}-${a.id}`} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0"><span className="badge badge-info mr-2">{KIND[a.kind]}</span>{a.hot && <span className="err">&#9650; </span>}<Link href={a.href} className="underline-offset-2 hover:underline">{a.title}</Link></span>
                  <span className={`shrink-0 text-xs ${new Date(a.at) < new Date() ? "err" : "muted"}`}>{when(a.at)}</span>
                </li>))}</ul>)}
          </div>
          <Attention items={d.attention} />
        </div>
        {d.targets.length > 0 && <div className="card p-4"><h2 className="mb-3 font-semibold">My targets this month</h2><TargetBars rows={d.targets.map((x) => ({ id: x.id, label: x.metric.replace(/_/g, " "), target: x.target, actual: x.actual, pct: x.pct, expectedPct: x.expectedPct, status: x.status }))} /></div>}
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="card p-4"><h2 className="mb-3 font-semibold">My pipeline by stage</h2><Funnel data={d.funnel} /></div>
          <div className="card p-4"><h2 className="mb-3 font-semibold">New leads per week</h2><Columns data={d.weekly} /></div>
        </div>
      </section>
    );
  }

  // Team / company view
  const t = await teamDashboard(sq, ctx);
  const dash = async (k: DashboardKind): Promise<any | null> => { try { return await getDashboard(sq, ctx, k); } catch { return null; } };
  const [prop, comp] = await Promise.all([dash("property"), dash("compliance")]);
  const count = async (table: string) => Number(((await sq.query<{ n: number }>(`SELECT COUNT(*) n FROM \`${table}\` WHERE tenant_id=:t`, { replacements: { t: ctx.tenantId }, type: QueryTypes.SELECT }))[0]?.n) ?? 0);
  const org = [
    hasPermission(ctx, "user.read") && { label: "Users", value: await count("users") },
    hasPermission(ctx, "org.read") && { label: "Branches", value: await count("branches") },
    hasPermission(ctx, "project.read") && { label: "Projects", value: await count("projects") },
    hasPermission(ctx, "audit.read") && { label: "Audit events", value: await count("audit_events") },
  ].filter(Boolean) as { label: string; value: number }[];
  const ops: { label: string; value: string | number }[] = [
    ...(prop ? [{ label: "Occupancy", value: prop.units.occupancyRate === null ? "-" : `${Math.round(prop.units.occupancyRate * 100)}%` }, { label: "Overdue rent (AED)", value: fmtNum(Number(prop.rentOverdue.outstanding)) }, { label: "Leases expiring (90d)", value: prop.leasesExpiring90d }, { label: "Tickets past SLA", value: prop.maintenance.slaBreachedOpen }] : []),
    ...(comp ? [{ label: "Open compliance cases", value: comp.cases.open + comp.cases.escalated }, { label: "KYC expiring (30d)", value: comp.kyc.expiringIn30d }, { label: "Overdue data requests", value: comp.dsr.overdue }] : []),
    ...org,
  ];
  return (
    <section className="flex flex-col gap-6">
      <div className="page-head"><div><h1>{greeting}</h1><p className="muted text-sm">How the team is doing across everything you can see.</p></div><Tabs view="team" /></div>
      <KpiGrid kpis={t.kpis} />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2"><Attention items={t.attention} /></div>
        <div className="card p-4"><h2 className="mb-2 font-semibold">Waiting for your decision</h2>
          {t.approvals.length === 0 ? <p className="muted text-sm">Nothing is waiting on you.</p> : <ul className="flex flex-col gap-1.5 text-sm">{t.approvals.map((a) => <li key={a.label}><Link href={a.href} className="flex items-center justify-between gap-3 rounded-lg px-3 py-1.5 hover:opacity-80" style={{ background: "var(--accent-soft)" }}><span>{a.label}</span><b>{a.count}</b></Link></li>)}</ul>}
        </div>
      </div>
      {t.targets.length > 0 && <div className="card p-4"><h2 className="mb-3 font-semibold">Targets this month</h2><TargetBars rows={t.targets.map((x) => ({ id: x.id, label: `${x.scopeName}: ${x.metric.replace(/_/g, " ")}`, target: x.target, actual: x.actual, pct: x.pct, expectedPct: x.expectedPct, status: x.status }))} /></div>}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="card p-4"><h2 className="mb-3 font-semibold">Open leads by stage</h2><Funnel data={t.funnel} /></div>
        <div className="card p-4"><h2 className="mb-3 font-semibold">New leads per week (12 weeks)</h2><Columns data={t.weekly} /></div>
        {t.dealStages.some((d) => d.value > 0) && <div className="card p-4"><h2 className="mb-3 font-semibold">Open deals by stage</h2><BarList data={t.dealStages} /></div>}
        {t.sources.length > 0 && <div className="card p-4"><h2 className="mb-3 font-semibold">Where leads come from</h2><BarList data={t.sources.map((s) => ({ label: s.label, value: s.leads, hint: s.leads ? `${Math.round((s.won / s.leads) * 100)}% won` : undefined }))} /></div>}
      </div>
      {t.workload.length > 0 && (
        <div className="card overflow-x-auto p-4">
          <h2 className="mb-3 font-semibold">Team workload</h2>
          <table className="t"><thead><tr><th>Agent</th><th>Open leads</th><th>Hot</th><th>Overdue follow-ups</th><th>Won</th><th>Closed this month (AED)</th></tr></thead>
            <tbody>{t.workload.map((w) => <tr key={w.agent}><td>{w.agent}</td><td>{w.open}</td><td>{w.hot}</td><td className={w.overdue ? "err font-semibold" : ""}>{w.overdue}</td><td>{w.won}</td><td>{fmtNum(w.closedValue)}</td></tr>)}</tbody></table>
        </div>
      )}
      {ops.length > 0 && (
        <div><h2 className="mb-3 text-lg font-semibold">Operations</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{ops.map((o) => <div key={o.label} className="card stat"><p className="muted text-xs font-medium uppercase tracking-wide">{o.label}</p><b>{typeof o.value === "number" ? fmtNum(o.value) : o.value}</b></div>)}</div></div>
      )}
    </section>
  );
}
