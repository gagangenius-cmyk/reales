import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getAvailability, listAssignableUsers } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { SlotFinder, TimeOffPanel, WeeklyEditor } from "./availability-client";

export const metadata = { title: "Availability | Reales CRM" };

export default async function Availability({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "viewing.read")) return <NoAccess />;
  const sp = await searchParams;
  const sq = getSequelize();
  const team = await listAssignableUsers(sq, ctx); // me for an agent, my branch for a manager, everyone for an admin
  const choice = team.find((t) => t.id === sp.user) ?? team.find((t) => t.id === ctx.userId) ?? team[0];
  const userId = choice?.id ?? ctx.userId;
  const data = await getAvailability(sq, ctx, userId);
  const canEdit = can(ctx, "viewing.manage", { ownerUserId: userId });
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head">
        <div><h1>Availability</h1><p className="muted text-sm">Working hours and time off decide when viewings can be booked. Times are Dubai time.</p></div>
        {team.length > 1 && (
          <form action="/availability" className="flex items-center gap-2">
            <select name="user" defaultValue={userId} className="input w-auto" aria-label="Agent">{team.map((t) => <option key={t.id} value={t.id}>{t.email}{t.id === ctx.userId ? " (me)" : ""}</option>)}</select>
            <button className="btn-ghost">View</button>
          </form>
        )}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <WeeklyEditor key={userId} userId={userId} initial={(data.windows as any[]).map((w) => ({ weekday: w.weekday, startTime: w.startTime, endTime: w.endTime }))} canEdit={canEdit} />
        <div className="flex flex-col gap-5">
          <TimeOffPanel key={userId} userId={userId} items={(data.timeOff as any[]).map((t) => ({ id: t.id, startsAt: new Date(t.startsAt).toISOString(), endsAt: new Date(t.endsAt).toISOString(), reason: t.reason }))} canEdit={canEdit} />
          <SlotFinder agents={team.map((t) => ({ id: t.id, email: t.email }))} />
        </div>
      </div>
      <p className="muted text-xs">Booking a viewing outside these hours, or during time off, is refused. Agents with no hours set are not restricted. <Link className="underline" href="/viewings">Go to viewings</Link></p>
    </section>
  );
}
