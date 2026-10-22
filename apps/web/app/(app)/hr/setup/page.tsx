import { getSequelize } from "@reales/database";
import { listHolidays, listLeaveTypes, listShifts } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { SetupClient } from "./setup-client";

export const metadata = { title: "HR setup | Reales CRM" };

export default async function Setup({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "hr.manage")) return <NoAccess />;
  const sp = await searchParams;
  const year = Number(sp.year) || new Date().getFullYear();
  const sq = getSequelize();
  const [types, shifts, holidays] = await Promise.all([listLeaveTypes(sq, ctx, true), listShifts(sq, ctx), listHolidays(sq, ctx, year)]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>HR setup</h1><p className="muted text-sm">Leave types and entitlements, working shifts and public holidays. Everything here is yours to configure.</p></div></div>
      <SetupClient types={types as never} shifts={shifts as never} holidays={holidays as never} year={year} />
    </section>
  );
}
