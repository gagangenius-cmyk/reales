import { getSequelize } from "@reales/database";
import { listAuditEvents } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";

export const metadata = { title: "Audit log | Reales CRM" };

export default async function Audit() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "audit.read")) return <NoAccess />;
  const events: any[] = await listAuditEvents(getSequelize(), ctx, { limit: 100, offset: 0 });
  return (
    <section>
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <p className="muted text-sm">Append-only and hash-chained. Entries cannot be edited or deleted.</p>
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>#</th><th>When (UTC)</th><th>Action</th><th>Entity</th><th>Actor</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{String(e.seq)}</td>
                <td>{new Date(e.createdAt).toISOString().slice(0, 19).replace("T", " ")}</td>
                <td>{e.action}</td><td>{e.entityType}</td><td>{e.actorId ?? "system"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
