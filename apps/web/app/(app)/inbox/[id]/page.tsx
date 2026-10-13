import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getConversation } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { ReplyForm } from "./reply-form";

export const metadata = { title: "Conversation | Reales CRM" };

export default async function Conversation({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "inbox.read")) return <NoAccess />;
  const { id } = await params;
  let c: any;
  try { c = await getConversation(getSequelize(), ctx, id); } catch {
    return <section><h1 className="text-2xl font-semibold">Conversation not found</h1><Link className="btn-ghost mt-3 inline-block" href="/inbox">Back to inbox</Link></section>;
  }
  const canSend = can(ctx, "inbox.send", { ownerUserId: c.assignedUserId, branchId: c.branchId });
  return (
    <section className="flex flex-col gap-4">
      <div><Link className="muted text-sm" href="/inbox">Back to inbox</Link><h1 className="text-2xl font-semibold">{c.channel} conversation</h1></div>
      <div className="card flex flex-col gap-3 p-4" aria-live="polite">
        {c.messages.map((m: any) => (
          <div key={m.id} className={m.direction === "outbound" ? "self-end text-right" : "self-start"} style={{ maxWidth: "80%" }}>
            <div className="card px-3 py-2 text-sm" style={{ background: m.direction === "outbound" ? "var(--accent)" : undefined, color: m.direction === "outbound" ? "#fff" : undefined }}>{m.body}</div>
            <p className="muted text-xs">{new Date(m.occurredAt).toISOString().slice(0, 16).replace("T", " ")} - {m.status}{m.error ? ` - ${m.error}` : ""}</p>
          </div>
        ))}
        {c.messages.length === 0 && <p className="muted">No messages yet.</p>}
      </div>
      {canSend && <ReplyForm contactId={c.contactId} channel={c.channel} />}
    </section>
  );
}
