import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listOrg, listTeamsDetailed, listUsers } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { TeamsPanel } from "./teams-panel";

export const metadata = { title: "Organization | Reales CRM" };

export default async function Organization() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "org.read")) return <NoAccess />;
  const sq = getSequelize();
  const [org, teams, users]: [any, any[], any[]] = await Promise.all([
    listOrg(sq, ctx) as Promise<any>, listTeamsDetailed(sq, ctx),
    hasPermission(ctx, "user.read") ? (listUsers(sq, ctx, { limit: 200, offset: 0 }).catch(() => []) as Promise<any[]>) : Promise.resolve([]),
  ]);
  const manage = hasPermission(ctx, "org.manage");
  const members = new Set(teams.flatMap((t) => t.members.map((m: any) => m.userId)));
  return (
    <section className="flex flex-col gap-6">
      <div className="page-head"><div><h1>Organization</h1><p className="muted text-sm">Business units, branches and teams. Team leaders and members drive shared targets and performance.</p></div>{hasPermission(ctx, "target.read") && <Link className="btn-ghost" href="/targets">Sales targets</Link>}</div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="card stat"><span className="muted text-xs">Business units</span><b>{org.businessUnits.length}</b></div>
        <div className="card stat"><span className="muted text-xs">Branches</span><b>{org.branches.length}</b></div>
        <div className="card stat"><span className="muted text-xs">Teams</span><b>{teams.length}</b></div>
        <div className="card stat"><span className="muted text-xs">People on a team</span><b>{members.size}</b></div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {org.businessUnits.map((bu: any) => (
          <div key={bu.id} className="card p-4">
            <p className="font-semibold">{bu.name} <span className="badge badge-gray ml-1">{bu.type}</span></p>
            <ul className="muted mt-2 list-disc pl-5 text-sm">
              {org.branches.filter((b: any) => b.businessUnitId === bu.id).map((b: any) => <li key={b.id}>{b.name}{b.city ? ` - ${b.city}` : ""} <span className="text-xs">({teams.filter((t) => t.branchId === b.id).length} teams)</span></li>)}
            </ul>
          </div>
        ))}
        {org.businessUnits.length === 0 && <p className="muted">No business units yet.</p>}
      </div>
      <div><h2 className="mb-3 text-lg font-semibold">Teams</h2>
        <TeamsPanel teams={teams as any} branches={org.branches.map((b: any) => ({ id: b.id, name: b.name }))} users={users.map((u) => ({ id: u.id, email: u.email }))} canManage={manage} />
      </div>
    </section>
  );
}
