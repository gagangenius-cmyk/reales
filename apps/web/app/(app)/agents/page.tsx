import { getSequelize } from "@reales/database";
import { listAgentDirectory, listCommissionPlans } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { AgentEditor } from "./agent-form";

export const metadata = { title: "Agents | Reales CRM" };

export default async function Agents() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "commission.plan.manage")) return <NoAccess />;
  const sq = getSequelize();
  const [rows, plans] = await Promise.all([listAgentDirectory(sq, ctx), listCommissionPlans(sq, ctx) as Promise<any[]>]);
  const planName = new Map(plans.map((p) => [p.id, p.name]));
  const internal = rows.filter((r) => (r.profile?.agentType ?? "internal") === "internal").length;
  return (
    <section>
      <div className="page-head"><div><h1>Agents</h1><p className="muted text-sm">Mark each person as an internal agent or an external agent (freelancer or partner brokerage). The type decides which commission plan applies.</p></div></div>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="card stat"><span className="muted text-xs">People</span><b>{rows.length}</b></div>
        <div className="card stat"><span className="muted text-xs">Internal</span><b>{internal}</b></div>
        <div className="card stat"><span className="muted text-xs">External</span><b>{rows.length - internal}</b></div>
      </div>
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr><th>Person</th><th>Type</th><th>BRN</th><th>Agency</th><th>Plan</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const p = r.profile;
              return (
                <tr key={r.userId}>
                  <td>{r.email}</td>
                  <td><span className={`badge ${p?.agentType === "external" ? "badge-warn" : ""}`}>{p?.agentType ?? "internal (default)"}</span></td>
                  <td>{p?.brn ?? "-"}</td><td>{p?.agencyName ?? "-"}</td><td>{p?.commissionPlanId ? (planName.get(p.commissionPlanId) ?? "-") : "Automatic"}</td>
                  <td><span className={`badge ${p?.status === "inactive" ? "badge-gray" : "badge-ok"}`}>{p?.status ?? "active"}</span></td>
                  <td className="text-right"><AgentEditor row={r} plans={plans.map((x) => ({ id: x.id, name: x.name, agentType: x.agentType, dealType: x.dealType }))} canManage /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
