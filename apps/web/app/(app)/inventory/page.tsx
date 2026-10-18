import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listInventoryTree, listUnits } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { UnitStatusSelect } from "./unit-status-select";
import { InventoryDrawer } from "./inventory-drawer";

export const metadata = { title: "Inventory | Reales CRM" };

const STATUSES = ["available", "reserved", "sold", "rented", "blocked"] as const;
const tone: Record<string, string> = { available: "badge-ok", reserved: "badge-warn", sold: "badge-gray", rented: "", blocked: "badge-danger" };
type SP = { status?: string; type?: string; beds?: string; project?: string; q?: string };

export default async function Inventory({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "inventory.read") && !hasPermission(ctx, "inventory.manage")) return <NoAccess />;
  const sp = await searchParams;
  const sq = getSequelize();
  const status = STATUSES.includes(sp.status as never) ? sp.status : undefined;
  const type = ["apartment", "villa", "townhouse", "penthouse", "office", "retail", "land"].includes(sp.type ?? "") ? sp.type : undefined;
  const beds = sp.beds !== undefined && sp.beds !== "" && Number.isInteger(Number(sp.beds)) ? Number(sp.beds) : undefined;
  const [tree, all, units] = await Promise.all([
    listInventoryTree(sq, ctx) as Promise<any>,
    listUnits(sq, ctx, { limit: 200, offset: 0 }) as Promise<any[]>, // for the status tiles
    listUnits(sq, ctx, { limit: 200, offset: 0, status, type, bedrooms: beds, reProjectId: sp.project || undefined }) as Promise<any[]>,
  ]);
  const building = new Map<string, any>(tree.buildings.map((b: any) => [b.id, b]));
  const project = new Map<string, any>(tree.projects.map((p: any) => [p.id, p]));
  const q = sp.q?.trim().toLowerCase();
  const rows = q ? units.filter((u) => `${u.unitNumber} ${building.get(u.buildingId)?.name ?? ""} ${building.get(u.buildingId)?.community ?? ""} ${u.view ?? ""}`.toLowerCase().includes(q)) : units;
  const manage = can(ctx, "inventory.manage");
  const count = (s: string) => all.filter((u) => u.status === s).length;
  const value = all.filter((u) => u.status === "available").reduce((a, u) => a + Number(u.listPrice ?? 0), 0);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head">
        <div><h1>Inventory</h1><p className="muted text-sm">{tree.developers.length} developer(s), {tree.projects.length} project(s), {tree.buildings.length} building(s), {all.length} unit(s)</p></div>
        {manage && <InventoryDrawer developers={tree.developers.map((d: any) => ({ id: d.id, name: d.name }))} projects={tree.projects.map((p: any) => ({ id: p.id, name: p.name }))} buildings={tree.buildings.map((b: any) => ({ id: b.id, name: b.name, projectName: project.get(b.reProjectId)?.name ?? "" }))} />}
      </div>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STATUSES.map((s) => <Link key={s} href={`/inventory?status=${s}`} className="card stat"><span className="muted text-xs capitalize">{s}</span><b>{count(s)}</b></Link>)}
        <div className="card stat"><span className="muted text-xs">Available value</span><b className="text-xl">{Math.round(value).toLocaleString("en-US")}</b></div>
      </div>
      <form className="card flex flex-wrap items-end gap-3 p-3" action="/inventory">
        <label className="grow text-sm"><span className="muted text-xs font-medium">Search</span><input className="input mt-1" name="q" defaultValue={sp.q ?? ""} placeholder="Unit, building, community or view" /></label>
        <label className="text-sm"><span className="muted text-xs font-medium">Status</span><select className="input mt-1" name="status" defaultValue={status ?? ""}><option value="">All</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label className="text-sm"><span className="muted text-xs font-medium">Type</span><select className="input mt-1" name="type" defaultValue={type ?? ""}><option value="">All</option>{["apartment", "villa", "townhouse", "penthouse", "office", "retail", "land"].map((t) => <option key={t}>{t}</option>)}</select></label>
        <label className="text-sm"><span className="muted text-xs font-medium">Bedrooms</span><input className="input mt-1 w-24" name="beds" type="number" min="0" defaultValue={sp.beds ?? ""} /></label>
        <label className="text-sm"><span className="muted text-xs font-medium">Project</span><select className="input mt-1" name="project" defaultValue={sp.project ?? ""}><option value="">All</option>{tree.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button className="btn">Filter</button>{(sp.q || status || type || sp.beds || sp.project) && <Link className="btn-ghost" href="/inventory">Clear</Link>}
      </form>
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr><th>Project</th><th>Building</th><th>Unit</th><th>Type</th><th>Beds</th><th>Area (sqft)</th><th>View</th><th>Price</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((u) => {
              const b = building.get(u.buildingId);
              const p = b ? project.get(b.reProjectId) : null;
              return (
                <tr key={u.id}>
                  <td>{p?.name ?? "-"} {p?.kind === "off_plan" && <span className="badge badge-warn">off-plan</span>}</td><td>{b?.name ?? "-"}{b?.community ? <span className="muted text-xs"> &middot; {b.community}</span> : null}</td>
                  <td className="font-medium">{u.unitNumber}</td><td>{u.type}</td><td>{u.bedrooms ?? "-"}</td><td>{u.areaSqft ? Number(u.areaSqft).toLocaleString("en-US") : "-"}</td><td>{u.view ?? "-"}</td>
                  <td>{u.listPrice ? `${u.currency} ${Number(u.listPrice).toLocaleString("en-US")}` : "-"}</td>
                  <td>{manage ? <UnitStatusSelect unitId={u.id} status={u.status} /> : <span className={`badge ${tone[u.status] ?? ""}`}>{u.status}</span>}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={9} className="muted">No units match. {manage ? "Use Add to inventory to create one." : ""}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
