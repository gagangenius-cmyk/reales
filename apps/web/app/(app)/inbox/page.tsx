import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listConversations } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";

export const metadata = { title: "Inbox | Reales CRM" };

export default async function Inbox() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "inbox.read")) return <NoAccess />;
  const convs: any[] = await listConversations(getSequelize(), ctx, { limit: 100, offset: 0 });
  return (
    <section>
      <h1 className="text-2xl font-semibold">Inbox</h1>
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Channel</th><th>Last activity (UTC)</th><th>Unread</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {convs.map((c) => (
              <tr key={c.id}>
                <td>{c.channel}</td><td>{c.lastMessageAt ? new Date(c.lastMessageAt).toISOString().slice(0, 16).replace("T", " ") : "-"}</td>
                <td>{c.unreadCount > 0 ? <strong>{c.unreadCount}</strong> : 0}</td><td>{c.status}</td>
                <td><Link className="btn-ghost text-xs" href={`/inbox/${c.id}`}>Open</Link></td>
              </tr>
            ))}
            {convs.length === 0 && <tr><td colSpan={5} className="muted">No conversations in your inbox.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
