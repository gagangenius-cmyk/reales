import { getSequelize } from "@reales/database";
import { listViewings } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { ViewingActions } from "./viewing-actions";

export const metadata = { title: "Viewings | Reales CRM" };

export default async function Viewings() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "viewing.read")) return <NoAccess />;
  const viewings: any[] = await listViewings(getSequelize(), ctx, { limit: 100, offset: 0 });
  const manage = hasPermission(ctx, "viewing.manage");
  return (
    <section>
      <h1 className="text-2xl font-semibold">Viewings</h1>
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>When (UTC)</th><th>Duration</th><th>Status</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {viewings.map((v) => (
              <tr key={v.id}>
                <td>{new Date(v.scheduledAt).toISOString().slice(0, 16).replace("T", " ")}</td><td>{v.durationMin} min</td><td>{v.status}</td><td>{v.locationNote ?? "-"}</td>
                <td>{manage && can(ctx, "viewing.manage", { ownerUserId: v.agentUserId, branchId: v.branchId, projectId: v.projectId }) && ["scheduled", "checked_in"].includes(v.status) ? <ViewingActions id={v.id} status={v.status} /> : null}</td>
              </tr>
            ))}
            {viewings.length === 0 && <tr><td colSpan={5} className="muted">No viewings visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
