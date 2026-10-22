import { getSequelize } from "@reales/database";
import { getLeaveBalances, leaveCalendar, listLeaveRequests, listLeaveTypes, myEmployee } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { LeaveClient } from "./leave-client";

export const metadata = { title: "Leave | Reales CRM" };

export default async function Leave() {
  const ctx = await requireContext();
  const sq = getSequelize();
  const me = await myEmployee(sq, ctx);
  const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  const from = `${today.slice(0, 8)}01`, to = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const [balances, types, mine, team, calendar] = await Promise.all([
    me ? getLeaveBalances(sq, ctx, me.id) : Promise.resolve([]),
    listLeaveTypes(sq, ctx),
    me ? listLeaveRequests(sq, ctx, { scope: "mine" }) : Promise.resolve([]),
    listLeaveRequests(sq, ctx, { scope: "team", status: "pending" }),
    hasPermission(ctx, "hr.read") ? leaveCalendar(sq, ctx, from, to) : Promise.resolve([]),
  ]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Leave</h1><p className="muted text-sm">Your balances, requests and the approvals waiting for you.</p></div></div>
      <LeaveClient linked={!!me} balances={balances as never} types={types as never} mine={mine as never} approvals={team as never} calendar={calendar as never} month={today.slice(0, 7)} />
    </section>
  );
}
