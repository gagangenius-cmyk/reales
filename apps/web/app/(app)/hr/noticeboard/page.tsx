import { getSequelize } from "@reales/database";
import { celebrations, listAnnouncements } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { BoardClient } from "./board-client";

export const metadata = { title: "HR noticeboard | Reales CRM" };

export default async function HrNoticeboard() {
  const ctx = await requireContext();
  const sq = getSequelize();
  const manage = hasPermission(ctx, "hr.manage");
  const [news, party] = await Promise.all([listAnnouncements(sq, ctx, manage), celebrations(sq, ctx, 60)]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>HR noticeboard</h1><p className="muted text-sm">Announcements from HR, birthdays, work anniversaries, new joiners, company occasions and public holidays.</p></div></div>
      <BoardClient news={news as never} party={party as never} canManage={manage} nowIso={new Date().toISOString()} />
    </section>
  );
}
