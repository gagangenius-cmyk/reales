import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listAssignableUsers, listInventoryTree, listUnits, searchListings } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { ListingRow } from "./listing-row";
import { ListingDrawer } from "./listing-drawer";

export const metadata = { title: "Listings | Reales CRM" };

const PAGE = 25;
type SP = { q?: string; status?: string; purpose?: string; page?: string };

export default async function Listings({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "listing.read")) return <NoAccess />;
  const sp = await searchParams;
  const status = ["draft", "published", "unpublished"].includes(sp.status ?? "") ? sp.status : undefined;
  const purpose = ["sale", "rent"].includes(sp.purpose ?? "") ? sp.purpose : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const sq = getSequelize();
  const manage = hasPermission(ctx, "listing.manage");
  const readInv = hasPermission(ctx, "inventory.read") || hasPermission(ctx, "inventory.manage");
  const [res, agents, tree, units] = await Promise.all([
    searchListings(sq, ctx, { limit: PAGE, offset: (page - 1) * PAGE, status, purpose, q: sp.q }),
    manage ? listAssignableUsers(sq, ctx) : Promise.resolve([]),
    manage && readInv ? listInventoryTree(sq, ctx) : Promise.resolve(null),
    manage && readInv ? (listUnits(sq, ctx, { limit: 200, offset: 0, status: "available" }) as Promise<any[]>) : Promise.resolve([]),
  ]);
  const bName = new Map<string, string>((tree?.buildings ?? []).map((b: any) => [b.id, `${b.name}${b.community ? `, ${b.community}` : ""}`]));
  const unitOpts = units.map((u: any) => ({ id: u.id, label: `${u.unitNumber} - ${bName.get(u.buildingId) ?? "Building"} - ${u.bedrooms ?? "?"} bed ${u.type}${u.listPrice ? ` - ${u.currency} ${Number(u.listPrice).toLocaleString("en-US")}` : ""}`, listPrice: u.listPrice ? Number(u.listPrice) : null, currency: u.currency }));
  const pages = Math.max(1, Math.ceil(res.total / PAGE));
  const qs = (over: Partial<SP>) => { const p = new URLSearchParams(); const m = { q: sp.q, status, purpose, ...over }; for (const [k, v] of Object.entries(m)) if (v) p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : "?"; };
  return (
    <section>
      <div className="page-head">
        <div><h1>Listings</h1><p className="muted text-sm">{res.total} listing{res.total === 1 ? "" : "s"}. Publishing is blocked until the permit, brokerage licence and required fields pass the jurisdiction rules.</p></div>
        {manage && <ListingDrawer mode="create" units={unitOpts} agents={agents.map((a) => ({ id: a.id, email: a.email }))} />}
      </div>
      <form className="card mb-4 flex flex-wrap items-end gap-3 p-3" action="/listings">
        <label className="grow text-sm"><span className="muted text-xs font-medium">Search</span><input className="input mt-1" name="q" defaultValue={sp.q ?? ""} placeholder="Title, unit number, building or community" /></label>
        <label className="text-sm"><span className="muted text-xs font-medium">Status</span><select className="input mt-1" name="status" defaultValue={status ?? ""}><option value="">All</option><option value="draft">Draft</option><option value="published">Published</option><option value="unpublished">Unpublished</option></select></label>
        <label className="text-sm"><span className="muted text-xs font-medium">Purpose</span><select className="input mt-1" name="purpose" defaultValue={purpose ?? ""}><option value="">All</option><option value="sale">Sale</option><option value="rent">Rent</option></select></label>
        <button className="btn">Filter</button>{(sp.q || status || purpose) && <Link className="btn-ghost" href="/listings">Clear</Link>}
      </form>
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr><th>Listing</th><th>Unit</th><th>Purpose</th><th>Price</th><th>Jurisdiction</th><th>Status</th><th>Compliance</th><th /></tr></thead>
          <tbody>
            {res.rows.map((l: any) => (
              <ListingRow key={l.id} listing={{ id: l.id, title: l.title ?? "(untitled)", purpose: l.purpose, price: l.price ? `${l.currency} ${Number(l.price).toLocaleString("en-US")}` : "-", jurisdiction: l.jurisdictionCode, status: l.status,
                unit: l.unit ? `${l.unit.unitNumber}${l.unit.building ? ` - ${l.unit.building}` : ""}${l.unit.bedrooms != null ? ` - ${l.unit.bedrooms} bed` : ""}` : "-" }}
                canPublish={can(ctx, "listing.publish", { ownerUserId: l.agentUserId, branchId: l.branchId, projectId: l.projectId })}
                edit={can(ctx, "listing.manage", { ownerUserId: l.agentUserId, branchId: l.branchId, projectId: l.projectId }) ? { target: { id: l.id, title: l.title ?? "", description: l.description ?? "", price: l.price ? Number(l.price) : null, agentUserId: l.agentUserId }, agents: agents.map((a) => ({ id: a.id, email: a.email })), canReassign: can(ctx, "lead.assign") } : undefined} />
            ))}
            {res.rows.length === 0 && <tr><td colSpan={8} className="muted">No listings match.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="muted">Page {page} of {pages}</span>
          <div className="flex gap-2">{page > 1 && <Link className="btn-ghost" href={qs({ page: String(page - 1) })}>Previous</Link>}{page < pages && <Link className="btn-ghost" href={qs({ page: String(page + 1) })}>Next</Link>}</div>
        </nav>
      )}
    </section>
  );
}
