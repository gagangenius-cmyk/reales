import { getSequelize } from "@reales/database";
import { listRoster, listShifts } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { RosterClient } from "./roster-client";

export const metadata = { title: "Shift roster | Reales CRM" };
const ymd = /^\d{4}-\d{2}-\d{2}$/;

export default async function Roster({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  const start = sp.from && ymd.test(sp.from) ? sp.from : today;
  const from = start, to = new Date(Date.parse(`${from}T00:00:00Z`) + 13 * 86_400_000).toISOString().slice(0, 10);
  const sq = getSequelize();
  const manage = hasPermission(ctx, "hr.manage");
  const [rows, shifts] = await Promise.all([listRoster(sq, ctx, from, to, !hasPermission(ctx, "hr.read")), listShifts(sq, ctx)]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Shift roster</h1><p className="muted text-sm">Two weeks at a time. Everyone follows their normal shift and weekly days off unless HR rosters a different shift or a day off for a date.</p></div></div>
      <RosterClient rows={rows as never} shifts={(shifts as any[]).map((s) => ({ id: s.id, name: s.name }))} from={from} to={to} canManage={manage} />
    </section>
  );
}
