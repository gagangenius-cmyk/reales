import Link from "next/link";
import { getSequelize } from "@reales/database";
import { CALL_OUTCOMES, callStats, listCalls } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { LogCallDrawer } from "./log-call-drawer";

export const metadata = { title: "Calls | Reales CRM" };

const PAGE = 30;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const tone = (o: string) => (o === "answered" ? "badge-ok" : o === "callback_requested" ? "" : o === "wrong_number" || o === "not_interested" ? "badge-gray" : "badge-warn");
type SP = { outcome?: string; from?: string; to?: string; page?: string; range?: string };

export default async function Calls({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "call.read") && !hasPermission(ctx, "call.log")) return <NoAccess />;
  const sp = await searchParams;
  const sq = getSequelize();
  const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() + 4 * 3_600_000 - 6 * 86_400_000).toISOString().slice(0, 10);
  const range = sp.range === "week" ? { from: weekAgo, to: today } : { from: today, to: today };
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : undefined, to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : undefined;
  const outcome = CALL_OUTCOMES.includes(sp.outcome as never) ? sp.outcome : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const canRead = hasPermission(ctx, "call.read");
  const [stats, rows] = canRead
    ? await Promise.all([callStats(sq, ctx, range), listCalls(sq, ctx, { limit: PAGE + 1, offset: (page - 1) * PAGE, outcome, from, to }) as Promise<any[]>])
    : [null, [] as any[]];
  const calls = rows.slice(0, PAGE);
  const qs = (o: Record<string, string | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries({ outcome, from, to, range: sp.range, ...o })) if (v) p.set(k, v); const s = p.toString(); return s ? `?${s}` : "?"; };
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head">
        <div><h1>Calls</h1><p className="muted text-sm">Every call is tied to its lead timeline, last-contacted date and follow-up.</p></div>
        {hasPermission(ctx, "call.log") && <LogCallDrawer />}
      </div>
      {stats && (
        <>
          <div className="flex items-center justify-between">
            <div className="grid flex-1 gap-3 sm:grid-cols-4">
              <div className="card stat"><span className="muted text-xs">Calls ({sp.range === "week" ? "7 days" : "today"})</span><b>{stats.total.calls}</b></div>
              <div className="card stat"><span className="muted text-xs">Answered</span><b>{stats.total.answered}</b></div>
              <div className="card stat"><span className="muted text-xs">Answer rate</span><b>{Math.round(stats.total.answerRate * 100)}%</b></div>
              <div className="card stat"><span className="muted text-xs">Talk time</span><b>{stats.total.talkMinutes} min</b></div>
            </div>
            <nav className="ml-4 inline-flex rounded-lg border p-0.5 text-sm" style={{ borderColor: "var(--border)" }} aria-label="Range"><Link className={`rounded-md px-3 py-1.5 ${sp.range !== "week" ? "btn" : ""}`} href={qs({ range: undefined, page: undefined })}>Today</Link><Link className={`rounded-md px-3 py-1.5 ${sp.range === "week" ? "btn" : ""}`} href={qs({ range: "week", page: undefined })}>7 days</Link></nav>
          </div>
          {stats.agents.length > 1 && (
            <div className="card overflow-x-auto">
              <table className="t"><thead><tr><th>Agent</th><th>Calls</th><th>Answered</th><th>Answer rate</th><th>Talk time</th><th>Avg answered</th><th>Callbacks</th></tr></thead>
                <tbody>{stats.agents.map((a) => <tr key={a.userId}><td className="font-medium">{a.agent}</td><td>{a.calls}</td><td>{a.answered}</td><td>{Math.round(a.answerRate * 100)}%</td><td>{a.talkMinutes} min</td><td>{mmss(a.avgSeconds)}</td><td>{a.callbacks}</td></tr>)}</tbody></table>
            </div>
          )}
        </>
      )}
      {canRead && (
        <>
          <form className="card flex flex-wrap items-end gap-3 p-3" action="/calls">
            <label className="text-sm"><span className="muted text-xs font-medium">Outcome</span><select className="input mt-1" name="outcome" defaultValue={outcome ?? ""}><option value="">All</option>{CALL_OUTCOMES.map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}</select></label>
            <label className="text-sm"><span className="muted text-xs font-medium">From</span><input className="input mt-1" type="date" name="from" defaultValue={from ?? ""} /></label>
            <label className="text-sm"><span className="muted text-xs font-medium">To</span><input className="input mt-1" type="date" name="to" defaultValue={to ?? ""} /></label>
            <button className="btn">Filter</button>{(outcome || from || to) && <Link className="btn-ghost" href="/calls">Clear</Link>}
          </form>
          <div className="card overflow-x-auto">
            <table className="t"><thead><tr><th>When</th><th>Agent</th><th>Contact</th><th>Direction</th><th>Outcome</th><th>Duration</th><th>Notes</th><th /></tr></thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td>{new Date(c.startedAt).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" })}</td><td>{c.agent}</td><td className="font-medium">{c.contactName}</td>
                    <td>{c.direction}</td><td><span className={`badge ${tone(c.outcome)}`}>{String(c.outcome).replace(/_/g, " ")}</span></td><td>{c.durationSec ? mmss(c.durationSec) : "-"}</td>
                    <td className="max-w-xs truncate text-xs">{c.notes ?? ""}</td><td className="text-right">{c.leadId && <Link className="btn-ghost text-xs" href={`/leads/${c.leadId}`}>Lead</Link>}</td>
                  </tr>
                ))}
                {calls.length === 0 && <tr><td colSpan={8} className="muted">No calls match.</td></tr>}
              </tbody></table>
          </div>
          {(page > 1 || rows.length > PAGE) && <nav className="flex items-center justify-between text-sm"><span className="muted">Page {page}</span><div className="flex gap-2">{page > 1 && <Link className="btn-ghost" href={qs({ page: String(page - 1) })}>Previous</Link>}{rows.length > PAGE && <Link className="btn-ghost" href={qs({ page: String(page + 1) })}>Next</Link>}</div></nav>}
        </>
      )}
    </section>
  );
}
