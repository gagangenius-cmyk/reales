import { getSequelize } from "@reales/database";
import { insightsOverview } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { BarList, Columns, Donut, Funnel } from "@/components/charts";
import { NoAccess } from "../no-access";

export const metadata = { title: "Insights | Reales CRM" };

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${Math.round(v * 100)}%`);
const aed = (v: number) => `AED ${Math.round(v).toLocaleString("en-US")}`;
const Panel = ({ title, hint, children, wide }: { title: string; hint?: string; children: React.ReactNode; wide?: boolean }) => (
  <section className={`card p-5 ${wide ? "xl:col-span-2" : ""}`}><h2 className="font-semibold">{title}</h2>{hint && <p className="muted mb-3 text-xs">{hint}</p>}<div className={hint ? "" : "mt-3"}>{children}</div></section>
);

export default async function Insights() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "analytics.read")) return <NoAccess />;
  const d: any = await insightsOverview(getSequelize(), ctx, 12);
  const lt = d.leadTotals, dt = d.dealTotals, resp = d.response;
  const tiles: [string, string, string?][] = [
    ...(lt ? [["Leads (all time)", String(lt.total)], ["Open leads", String(lt.open)], ["Hot", String(lt.hot), lt.hot ? "err" : ""], ["Overdue follow-ups", String(lt.overdueFollowUps), lt.overdueFollowUps ? "err" : ""], ["Unassigned", String(lt.unassigned)], ["Open budget", aed(lt.openBudget)]] as [string, string, string?][] : []),
    ...(dt ? [["Pipeline value", aed(dt.pipelineValue)], ["Closed value", aed(dt.closedValue)]] as [string, string, string?][] : []),
  ];
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Insights</h1><p className="muted text-sm">Figures cover what you are allowed to see. Updated {new Date(d.generatedAt).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" })}.</p></div></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{tiles.map(([l, v, c]) => <div key={l} className="card stat"><span className="muted text-xs">{l}</span><b className={`text-2xl ${c ?? ""}`}>{v}</b></div>)}</div>
      <div className="grid gap-5 xl:grid-cols-2">
        {d.funnel && <Panel title="Pipeline funnel" hint="Leads currently in each stage."><Funnel data={d.funnel} /></Panel>}
        {d.weeklyIntake && <Panel title="New leads per week" hint="Last 12 weeks."><Columns data={d.weeklyIntake} /></Panel>}
        {d.sources && <Panel title="Lead sources" hint="Volume, and how many became won deals."><BarList data={d.sources.map((s: any) => ({ label: s.label, value: s.leads, hint: `${s.won} won · ${pct(s.winRate)}` }))} /></Panel>}
        {d.campaigns && <Panel title="Campaigns" hint="Leads attributed to each campaign name, with open budget in play.">{d.campaigns.length ? <BarList data={d.campaigns.map((c: any) => ({ label: c.label, value: c.leads, hint: `${c.won} won · ${aed(c.pipeline)} open` }))} color="var(--accent-2)" /> : <p className="muted text-sm">Add a campaign when creating leads to see attribution here.</p>}</Panel>}
        {resp && (
          <Panel title="Response speed" hint="Time from enquiry to the first call, message or email.">
            <div className="grid grid-cols-3 gap-3">
              <div><p className="muted text-xs">Median</p><p className="text-2xl font-bold">{resp.medianMinutes === null ? "-" : `${resp.medianMinutes} min`}</p></div>
              <div><p className="muted text-xs">Within 15 min</p><p className="text-2xl font-bold">{pct(resp.within15)}</p></div>
              <div><p className="muted text-xs">Open, never answered</p><p className={`text-2xl font-bold ${resp.neverAnswered ? "err" : ""}`}>{resp.neverAnswered}</p></div>
            </div>
            <p className="muted mt-3 text-xs">Based on {resp.measured} answered lead(s).</p>
          </Panel>
        )}
        {d.lossReasons && <Panel title="Why leads are lost" hint="Reasons recorded when marking a lead lost.">{d.lossReasons.length ? <BarList data={d.lossReasons} color="var(--danger)" /> : <p className="muted text-sm">No lost leads yet.</p>}</Panel>}
        {d.dealStages && <Panel title="Deals by stage" hint="Count and value."><BarList data={d.dealStages.map((s: any) => ({ label: s.label, value: s.value, hint: aed(s.amount) }))} color="var(--ok)" /></Panel>}
        {d.inventory && <Panel title="Inventory"><Donut data={d.inventory} /></Panel>}
        {d.listingAge && <Panel title="Published listing age" hint="Old listings need a price or photo refresh."><BarList data={d.listingAge} color="var(--warn)" /></Panel>}
        {d.agents && (
          <Panel title="Agent leaderboard" wide>
            <div className="overflow-x-auto"><table className="t"><thead><tr><th>Agent</th><th>Open</th><th>Hot</th><th>Won</th><th>Lost</th><th>Win rate</th></tr></thead>
              <tbody>{d.agents.map((a: any) => <tr key={a.agent}><td className="font-medium">{a.agent}</td><td>{a.open}</td><td>{a.hot}</td><td>{a.won}</td><td>{a.lost}</td><td>{pct(a.winRate)}</td></tr>)}{d.agents.length === 0 && <tr><td colSpan={6} className="muted">No assigned leads yet.</td></tr>}</tbody></table></div>
          </Panel>
        )}
      </div>
    </section>
  );
}
