import { getSequelize } from "@reales/database";
import { listNoticesForMe, listOrg } from "@reales/domain";
import { hasPermission, widestScope } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { Composer, NoticeActions, Receipts } from "./notice-client";

export const metadata = { title: "Noticeboard | Reales CRM" };

export default async function Noticeboard() {
  const ctx = await requireContext();
  const sq = getSequelize();
  const manage = hasPermission(ctx, "notice.manage");
  const [notices, org]: [any[], any] = await Promise.all([listNoticesForMe(sq, ctx), manage && hasPermission(ctx, "org.read") ? (listOrg(sq, ctx) as Promise<any>) : Promise.resolve({ branches: [] })]);
  const wide = widestScope(ctx, "notice.manage") === "tenant";
  const branches = org.branches.filter((b: any) => wide || ctx.membership.branchIds.includes(b.id)).map((b: any) => ({ id: b.id, name: b.name }));
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Noticeboard</h1><p className="muted text-sm">Announcements, policy updates and reminders from management.</p></div>{manage && <Composer branches={branches} companyWide={wide} />}</div>
      <div className="flex flex-col gap-3">
        {notices.map((n) => (
          <article key={n.id} className="card p-5" style={{ borderLeft: n.pinned ? "4px solid var(--accent)" : undefined }}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h2 className="font-semibold">{n.pinned && <span title="Pinned">&#128204; </span>}{n.title}{!n.read && <span className="badge badge-warn ml-2">new</span>}{n.requiresAck && !n.acked && <span className="badge badge-danger ml-2">acknowledgement needed</span>}</h2>
                <p className="muted text-xs">{new Date(n.publishAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric" })}{n.audience === "branch" ? " · your branch" : ""}{n.expiresAt ? ` · until ${new Date(n.expiresAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short" })}` : ""}</p></div>
              <div className="flex flex-col items-end gap-2"><NoticeActions id={n.id} read={n.read} requiresAck={!!n.requiresAck} acked={n.acked} />{manage && (wide || n.createdBy === ctx.userId) && <Receipts id={n.id} />}</div>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm">{n.body}</p>
          </article>
        ))}
        {notices.length === 0 && <p className="muted text-sm">No notices right now.</p>}
      </div>
    </section>
  );
}
