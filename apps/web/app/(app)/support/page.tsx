import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listSupportTickets } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NewTicket } from "./support-client";

export const metadata = { title: "Support | Reales CRM" };

const PRIORITY_TONE: Record<string, string> = { urgent: "badge-danger", high: "badge-warn", normal: "", low: "badge-gray" };
const STATUS_TONE: Record<string, string> = { open: "badge-warn", in_progress: "", waiting: "badge-gray", resolved: "badge-ok", closed: "badge-gray" };

export default async function Support({ searchParams }: { searchParams: Promise<{ status?: string; mine?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const desk = hasPermission(ctx, "support.manage");
  const status = sp.status && ["active", "open", "in_progress", "waiting", "resolved", "closed"].includes(sp.status) ? sp.status : desk ? "active" : undefined;
  const tickets: any[] = await listSupportTickets(getSequelize(), ctx, { status, mine: sp.mine === "true", limit: 100 });
  const chips = [["active", "Active"], ["resolved", "Resolved"], ["closed", "Closed"]] as const;
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Support</h1><p className="muted text-sm">{desk ? "Everyone's tickets. Overdue means no reply within the response target." : "Ask the support team for help. Only you and the support team can see your tickets."}</p></div><NewTicket /></div>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter">
        {chips.map(([v, l]) => <Link key={v} className={status === v ? "btn" : "btn-ghost"} href={`/support?status=${v}`}>{l}</Link>)}
        <Link className={!status ? "btn" : "btn-ghost"} href="/support?status=">All</Link>
        {desk && <Link className={sp.mine === "true" ? "btn" : "btn-ghost"} href={`/support?mine=true${status ? `&status=${status}` : ""}`}>Raised by me</Link>}
      </nav>
      <div className="card overflow-x-auto">
        <table className="t"><thead><tr><th>#</th><th>Subject</th>{desk && <th>From</th>}<th>Type</th><th>Priority</th><th>Status</th>{desk && <th>Assigned</th>}<th>Opened</th></tr></thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.id}><td className="muted">#{t.number}</td><td className="font-medium"><Link href={`/support/${t.id}`}>{t.subject}</Link>{t.overdue && <span className="badge badge-danger ml-2">overdue</span>}</td>{desk && <td>{t.requester}</td>}
                <td><span className="badge badge-gray">{t.category}</span></td><td><span className={`badge ${PRIORITY_TONE[t.priority]}`}>{t.priority}</span></td><td><span className={`badge ${STATUS_TONE[t.status]}`}>{String(t.status).replace("_", " ")}</span></td>{desk && <td>{t.assignee ?? "-"}</td>}
                <td>{new Date(t.createdAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short" })}</td></tr>
            ))}
            {tickets.length === 0 && <tr><td colSpan={desk ? 8 : 6} className="muted">No tickets.</td></tr>}
          </tbody></table>
      </div>
    </section>
  );
}
