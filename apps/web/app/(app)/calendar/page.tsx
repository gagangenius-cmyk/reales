import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getCalendar } from "@reales/domain";
import { requireContext } from "@/lib/page-context";

export const metadata = { title: "Calendar | Reales CRM" };

const LABEL: Record<string, string> = { task: "Task", viewing: "Viewing", rent_due: "Rent due", lease_expiry: "Lease ends", inspection: "Inspection", ticket_sla: "SLA", dsr_due: "Privacy request", kyc_expiry: "KYC expiry" };
const COLOR: Record<string, string> = { task: "#2563eb", viewing: "#059669", rent_due: "#d97706", lease_expiry: "#dc2626", inspection: "#7c3aed", ticket_sla: "#db2777", dsr_due: "#0891b2", kyc_expiry: "#65a30d" };

const shift = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

export default async function Calendar({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const ctx = await requireContext();
  const { month } = await searchParams;
  const ym = /^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? "") ? month! : new Date().toISOString().slice(0, 7);
  const from = `${ym}-01`;
  const to = `${shift(ym, 1)}-01`;
  const events = await getCalendar(getSequelize(), ctx, { from, to });
  const byDay = new Map<string, typeof events>();
  for (const e of events) { const d = e.start.slice(0, 10); byDay.set(d, [...(byDay.get(d) ?? []), e]); }
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Calendar - {ym}</h1>
        <div className="flex gap-2">
          <Link className="btn-ghost text-sm" href={`/calendar?month=${shift(ym, -1)}`}>Previous</Link>
          <Link className="btn-ghost text-sm" href="/calendar">This month</Link>
          <Link className="btn-ghost text-sm" href={`/calendar?month=${shift(ym, 1)}`}>Next</Link>
          <a className="btn-ghost text-sm" href={`/api/v1/calendar/ics?from=${from}&to=${to}`}>Download .ics</a>
        </div>
      </div>
      <p className="muted text-sm">Everything dated that you can see: tasks, viewings, rent due dates, lease endings, inspections, maintenance deadlines and compliance deadlines.</p>
      <div className="flex flex-wrap gap-3 text-xs">{Object.keys(LABEL).map((k) => <span key={k}><span style={{ background: COLOR[k] }} className="mr-1 inline-block h-2 w-2 rounded-full" />{LABEL[k]}</span>)}</div>
      <div className="card divide-y">
        {[...byDay.entries()].map(([d, list]) => (
          <div key={d} className={`p-3 ${d === today ? "bg-blue-50 dark:bg-blue-950" : ""}`}>
            <p className="text-sm font-semibold">{new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}{d === today && " (today)"}</p>
            <ul className="mt-1 space-y-1 text-sm">
              {list.map((e) => (
                <li key={e.id} className="flex items-center gap-2">
                  <span style={{ background: COLOR[e.kind] }} className="inline-block h-2 w-2 shrink-0 rounded-full" aria-label={LABEL[e.kind]} />
                  <span className="muted w-14 shrink-0 text-xs">{e.allDay ? "all day" : e.start.slice(11, 16)}</span>
                  {e.link ? <Link className="underline" href={e.link}>{e.title}</Link> : e.title}
                  {e.detail && <span className="muted text-xs">({e.detail})</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {byDay.size === 0 && <p className="muted p-4 text-sm">Nothing scheduled this month.</p>}
      </div>
    </section>
  );
}
