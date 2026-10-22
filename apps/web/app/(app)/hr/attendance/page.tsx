import { getSequelize } from "@reales/database";
import { listEmployees, liveBoard, myAttendanceToday, myEmployee, timesheet } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { Clock } from "./clock";
import { LiveBoard, TimesheetView } from "./attendance-client";

export const metadata = { title: "Attendance | Reales CRM" };
const ymd = /^\d{4}-\d{2}-\d{2}$/;

export default async function Attendance({ searchParams }: { searchParams: Promise<{ employee?: string; from?: string; to?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const sq = getSequelize();
  const read = hasPermission(ctx, "hr.read"), correct = hasPermission(ctx, "hr.attendance.manage");
  const me = await myEmployee(sq, ctx);
  const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  const to = sp.to && ymd.test(sp.to) ? sp.to : today;
  const from = sp.from && ymd.test(sp.from) ? sp.from : `${today.slice(0, 8)}01`;
  const empId = read && sp.employee ? sp.employee : me?.id;
  const [now, board, emps, sheet] = await Promise.all([
    myAttendanceToday(sq, ctx), read ? liveBoard(sq, ctx) : Promise.resolve(null), read ? listEmployees(sq, ctx, { limit: 200, status: "active" }) : Promise.resolve(null),
    empId ? timesheet(sq, ctx, empId, from, to).catch(() => null) : Promise.resolve(null),
  ]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Attendance</h1><p className="muted text-sm">Live check-ins, breaks and daily records.</p></div></div>
      <div className="grid gap-4 lg:grid-cols-3"><Clock initial={now as never} /></div>
      {board && <LiveBoard initial={board as never} />}
      <TimesheetView sheet={sheet as never} employees={(emps?.rows ?? []).map((e: any) => ({ id: e.id, name: e.fullName }))} selected={empId ?? ""} from={from} to={to} canPick={read} canCorrect={correct} />
    </section>
  );
}
