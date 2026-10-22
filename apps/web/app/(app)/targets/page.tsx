import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listOrg, listTeamsDetailed, listUsers, periodBounds, targetProgress, type TargetPeriod } from "@reales/domain";
import { hasPermission, widestScope } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { DeleteTarget, TargetForm } from "./target-form";

export const metadata = { title: "Targets | Reales CRM" };

const LABEL: Record<string, string> = { closed_value: "Closed value", closed_deals: "Closed deals", new_leads: "New leads", viewings_done: "Viewings done" };
const fmt = (metric: string, v: number) => (metric === "closed_value" ? `AED ${Math.round(v).toLocaleString("en-US")}` : Math.round(v).toLocaleString("en-US"));
const TONE: Record<string, string> = { achieved: "badge-ok", ahead: "badge-ok", on_track: "", behind: "badge-danger" };

export default async function Targets({ searchParams }: { searchParams: Promise<{ period?: string; scope?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "target.read")) return <NoAccess />;
  const sp = await searchParams;
  const period: TargetPeriod = sp.period === "quarter" || sp.period === "year" ? sp.period : "month";
  const sq = getSequelize();
  const manage = hasPermission(ctx, "target.manage");
  const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  const { start, end } = periodBounds(period, today);
  const rows = await targetProgress(sq, ctx, { periodType: period });
  const [org, teams, users]: [any, any[], any[]] = manage
    ? await Promise.all([listOrg(sq, ctx) as Promise<any>, listTeamsDetailed(sq, ctx), hasPermission(ctx, "user.read") ? (listUsers(sq, ctx, { limit: 200, offset: 0 }).catch(() => []) as Promise<any[]>) : Promise.resolve([])])
    : [{ branches: [] }, [], []];
  const filtered = sp.scope ? rows.filter((r) => r.scopeType === sp.scope) : rows;
  const achieved = rows.filter((r) => r.status === "achieved").length, behind = rows.filter((r) => r.status === "behind").length;
  const q = (o: Record<string, string>) => `?${new URLSearchParams({ period, ...(sp.scope ? { scope: sp.scope } : {}), ...o })}`;
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head">
        <div><h1>Sales targets</h1><p className="muted text-sm">{period[0]!.toUpperCase() + period.slice(1)}: {start} to {end} (Dubai). &ldquo;Behind&rdquo; means more than 10 points under the share of the period that has passed.</p></div>
        <nav className="inline-flex rounded-lg border p-0.5 text-sm" style={{ borderColor: "var(--border)" }} aria-label="Period">
          {(["month", "quarter", "year"] as const).map((p) => <Link key={p} className={`rounded-md px-3 py-1.5 ${period === p ? "btn" : ""}`} href={q({ period: p })}>{p}</Link>)}
        </nav>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card stat"><span className="muted text-xs">Targets set</span><b>{rows.length}</b></div>
        <div className="card stat"><span className="muted text-xs">Achieved</span><b>{achieved}</b></div>
        <div className="card stat"><span className="muted text-xs">Behind</span><b className={behind ? "err" : ""}>{behind}</b></div>
      </div>
      {manage && <TargetForm period={period} periodStart={start} users={users.map((u) => ({ id: u.id, name: u.email }))} teams={teams.filter((t) => t.status === "active").map((t) => ({ id: t.id, name: t.name }))} branches={org.branches.map((b: any) => ({ id: b.id, name: b.name }))} canTenant={widestScope(ctx, "target.manage") === "tenant"} />}
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Who">
        <Link className={!sp.scope ? "btn" : "btn-ghost"} href={q({ scope: "" })}>All</Link>
        {[["user", "People"], ["team", "Teams"], ["branch", "Branches"], ["tenant", "Company"]].map(([v, l]) => <Link key={v} className={sp.scope === v ? "btn" : "btn-ghost"} href={q({ scope: v! })}>{l}</Link>)}
      </nav>
      <div className="grid gap-3 lg:grid-cols-2">
        {filtered.map((t) => (
          <div key={t.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div><p className="font-semibold">{t.scopeName}</p><p className="muted text-xs">{t.scopeType} &middot; {LABEL[t.metric]}</p></div>
              <span className={`badge ${TONE[t.status]}`}>{t.status.replace("_", " ")}</span>
            </div>
            <div className="mt-3 flex items-baseline justify-between"><b className="text-xl">{fmt(t.metric, t.actual)}</b><span className="muted text-sm">of {fmt(t.metric, t.target)} ({Math.round(t.pct * 100)}%)</span></div>
            <div className="relative mt-2 h-2.5 overflow-hidden rounded-full" style={{ background: "var(--card-2)" }} role="progressbar" aria-valuenow={Math.round(t.pct * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`${t.scopeName} progress`}>
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, t.pct * 100)}%`, background: t.status === "behind" ? "var(--danger)" : "linear-gradient(90deg, var(--accent), var(--accent-2))" }} />
              <span className="absolute inset-y-0 w-0.5" style={{ left: `${Math.min(100, t.expectedPct * 100)}%`, background: "var(--fg)", opacity: 0.5 }} title="Where the calendar is" />
            </div>
            {(t.note || manage) && <div className="mt-2 flex items-center justify-between text-xs"><span className="muted">{t.note}</span>{manage && <DeleteTarget id={t.id} />}</div>}
          </div>
        ))}
        {filtered.length === 0 && <p className="muted text-sm">No targets for this period{manage ? ". Set one above." : "."}</p>}
      </div>
    </section>
  );
}
