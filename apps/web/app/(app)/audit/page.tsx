import { getSequelize } from "@reales/database";
import { listAuditEvents } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { AuditTable } from "./audit-table";

export const metadata = { title: "Audit log | Reales CRM" };

export default async function Audit() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "audit.read")) return <NoAccess />;
  const events: any[] = await listAuditEvents(getSequelize(), ctx, { limit: 100, offset: 0 });
  return (
    <section>
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <p className="muted text-sm">Append-only and hash-chained. Entries cannot be edited or deleted.</p>
      <div className="card mt-4 p-4"><AuditTable rows={events.map((e) => ({ id: e.id, seq: String(e.seq), when: new Date(e.createdAt).toISOString().slice(0, 19).replace("T", " "), action: e.action, entityType: e.entityType, actor: e.actorId ?? "system" }))} /></div>
    </section>
  );
}
