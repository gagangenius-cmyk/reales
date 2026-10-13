import { getSequelize } from "@reales/database";
import { listOrg } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";

export const metadata = { title: "Organization | Reales CRM" };

export default async function Organization() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "org.read")) return <NoAccess />;
  const org: any = await listOrg(getSequelize(), ctx);
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Organization</h1>
      {org.businessUnits.map((bu: any) => (
        <div key={bu.id} className="card p-4">
          <p className="font-semibold">{bu.name} <span className="muted text-xs">({bu.type})</span></p>
          <ul className="muted mt-2 list-disc pl-5 text-sm">
            {org.branches.filter((b: any) => b.businessUnitId === bu.id).map((b: any) => <li key={b.id}>{b.name}{b.city ? ` - ${b.city}` : ""}</li>)}
          </ul>
        </div>
      ))}
      {org.businessUnits.length === 0 && <p className="muted">No business units yet.</p>}
      <p className="muted text-sm">{org.teams.length} team(s)</p>
    </section>
  );
}
