import { getSequelize } from "@reales/database";
import { listInventoryTree, listUnits } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { UnitStatusSelect } from "./unit-status-select";

export const metadata = { title: "Inventory | Reales CRM" };

export default async function Inventory({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "inventory.read") && !hasPermission(ctx, "inventory.manage")) return <NoAccess />;
  const { status } = await searchParams;
  const sq = getSequelize();
  const valid = ["available", "reserved", "sold", "rented", "blocked"].includes(status ?? "") ? status : undefined;
  const [tree, units] = await Promise.all([listInventoryTree(sq, ctx) as Promise<any>, listUnits(sq, ctx, { limit: 200, offset: 0, status: valid }) as Promise<any[]>]);
  const building = new Map<string, any>(tree.buildings.map((b: any) => [b.id, b]));
  const project = new Map<string, any>(tree.projects.map((p: any) => [p.id, p]));
  const manage = can(ctx, "inventory.manage");
  return (
    <section>
      <h1 className="text-2xl font-semibold">Inventory</h1>
      <p className="muted text-sm">{tree.developers.length} developer(s), {tree.projects.length} project(s), {tree.buildings.length} building(s)</p>
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Project</th><th>Building</th><th>Unit</th><th>Type</th><th>Beds</th><th>Area (sqft)</th><th>Price</th><th>Status</th></tr></thead>
          <tbody>
            {units.map((u) => {
              const b = building.get(u.buildingId);
              const p = b ? project.get(b.reProjectId) : null;
              return (
                <tr key={u.id}>
                  <td>{p?.name ?? "-"} <span className="muted text-xs">{p?.kind === "off_plan" ? "off-plan" : ""}</span></td><td>{b?.name ?? "-"}</td><td>{u.unitNumber}</td><td>{u.type}</td>
                  <td>{u.bedrooms ?? "-"}</td><td>{u.areaSqft ? Number(u.areaSqft).toLocaleString("en-US") : "-"}</td>
                  <td>{u.listPrice ? `${u.currency} ${Number(u.listPrice).toLocaleString("en-US")}` : "-"}</td>
                  <td>{manage ? <UnitStatusSelect unitId={u.id} status={u.status} /> : u.status}</td>
                </tr>
              );
            })}
            {units.length === 0 && <tr><td colSpan={8} className="muted">No units yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
