import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getSupportTicket, listUsers } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { TicketThread } from "../support-client";

export const metadata = { title: "Ticket | Reales CRM" };

const dt = (v: unknown) => new Date(v as string).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" });

export default async function Ticket({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;
  const sq = getSequelize();
  let t: any;
  try { t = await getSupportTicket(sq, ctx, id); } catch { return <section><h1 className="text-2xl font-semibold">Ticket not found</h1><Link className="btn-ghost mt-3 inline-block" href="/support">Back to support</Link></section>; }
  const desk = hasPermission(ctx, "support.manage");
  const staff: any[] = desk && hasPermission(ctx, "user.read") ? await listUsers(sq, ctx, { limit: 200, offset: 0 }).catch(() => []) : [];
  return (
    <section className="flex flex-col gap-4">
      <div><Link className="muted text-sm" href="/support">&larr; Support</Link><h1>#{t.number} {t.subject}</h1>
        <p className="muted text-sm">{t.category} &middot; {t.priority} priority &middot; {String(t.status).replace("_", " ")} &middot; from {t.requester} &middot; opened {dt(t.createdAt)}{t.assignee ? ` · assigned to ${t.assignee}` : ""}{t.dueAt && !t.firstResponseAt && ["open", "in_progress"].includes(t.status) ? ` · reply due ${dt(t.dueAt)}` : ""}</p></div>
      <div className="card p-4"><p className="whitespace-pre-wrap text-sm">{t.body}</p>{t.pageUrl && <p className="muted mt-2 text-xs">Raised from {t.pageUrl}</p>}</div>
      <ul className="flex flex-col gap-2">
        {t.comments.map((c: any) => (
          <li key={c.id} className="card p-4 text-sm" style={c.internal ? { background: "var(--accent-soft)" } : undefined}>
            <p className="muted mb-1 text-xs"><b>{c.author}</b> &middot; {dt(c.createdAt)}{c.internal && <span className="badge badge-warn ml-2">internal note</span>}</p><p className="whitespace-pre-wrap">{c.body}</p>
          </li>
        ))}
      </ul>
      <TicketThread id={t.id} status={t.status} desk={desk} mine={t.requesterId === ctx.userId} staff={staff.map((u) => ({ id: u.id, email: u.email }))} assigneeId={t.assigneeId ?? null} priority={t.priority} />
    </section>
  );
}
