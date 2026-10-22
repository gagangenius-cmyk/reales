import Link from "next/link";
import { getSequelize } from "@reales/database";
import { celebrations, hrDashboard, listAnnouncements, myAttendanceToday } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { BarList } from "@/components/charts";
import { requireContext } from "@/lib/page-context";
import { Clock } from "./attendance/clock";

export const metadata = { title: "HR | Reales CRM" };
const ICON: Record<string, string> = { birthday: "Birthday", anniversary: "Work anniversary", new_joiner: "New joiner", occasion: "Occasion", holiday: "Public holiday" };
const nice = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });

export default async function HrHome() {
  const ctx = await requireContext();
  const sq = getSequelize();
  const read = hasPermission(ctx, "hr.read");
  const [today, news, party, dash] = await Promise.all([myAttendanceToday(sq, ctx), listAnnouncements(sq, ctx), celebrations(sq, ctx, 30), read ? hrDashboard(sq, ctx) : Promise.resolve(null)]);
  const stat = (label: string, value: number | string, href?: string, warn = false) => {
    const body = <><span className="muted text-xs">{label}</span><b className={warn && Number(value) > 0 ? "err" : ""}>{value}</b></>;
    return href ? <Link href={href} className="card stat">{body}</Link> : <div className="card stat">{body}</div>;
  };
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Human resources</h1><p className="muted text-sm">Check in, leave, announcements and who is celebrating.</p></div></div>
      {dash && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {stat("Active employees", dash.headcount.active, "/hr/employees")}
          {stat("Present today", dash.today.present, "/hr/attendance")}
          {stat("Late today", dash.today.late, "/hr/attendance", true)}
          {stat("On leave today", dash.today.onLeave, "/hr/leave")}
          {stat("Leave to approve", dash.pendingLeave, "/hr/leave", true)}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1"><Clock initial={today as never} /></div>
        <div className="card p-4 lg:col-span-1">
          <h2 className="mb-2 font-semibold">Announcements</h2>
          {news.length === 0 ? <p className="muted text-sm">Nothing new.</p> : <ul className="flex flex-col gap-3 text-sm">{news.slice(0, 4).map((a: any) => <li key={a.id}><b>{a.pinned && "Pinned: "}{a.title}</b><p className="muted line-clamp-3">{a.body}</p></li>)}</ul>}
          <Link href="/hr/noticeboard" className="mt-2 inline-block text-xs">Open the noticeboard</Link>
        </div>
        <div className="card p-4 lg:col-span-1">
          <h2 className="mb-2 font-semibold">Coming up</h2>
          {party.length === 0 ? <p className="muted text-sm">No birthdays, anniversaries or occasions in the next 30 days.</p> : <ul className="flex flex-col gap-2 text-sm">{party.slice(0, 8).map((c, i) => <li key={i} className="flex justify-between gap-2"><span><b>{c.title}</b><span className="muted block text-xs">{ICON[c.kind]}{c.detail ? ` - ${c.detail}` : ""}</span></span><span className="muted whitespace-nowrap text-xs">{c.daysAway === 0 ? "Today" : nice(c.date)}</span></li>)}</ul>}
        </div>
      </div>
      {dash && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card p-4"><h2 className="mb-3 font-semibold">Headcount by department</h2><BarList data={dash.byDepartment} /></div>
          <div className="card p-4"><h2 className="mb-2 font-semibold">Needs attention</h2>
            {dash.expiring.length === 0 && dash.probationEnding.length === 0 ? <p className="muted text-sm">Nothing is expiring in the next 60 days.</p> : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {dash.expiring.map((x, i) => <li key={`e${i}`}><Link href={`/hr/employees/${x.employeeId}`}>{x.name}</Link> <span className={x.expired ? "err" : "muted"}>{x.what} {x.expired ? "expired" : "expires"} {nice(x.date)}</span></li>)}
                {dash.probationEnding.map((x, i) => <li key={`p${i}`}><Link href={`/hr/employees/${x.employeeId}`}>{x.name}</Link> <span className="muted">probation ends {nice(x.date)}</span></li>)}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
