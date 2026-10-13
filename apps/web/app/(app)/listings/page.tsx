import { getSequelize } from "@reales/database";
import { listListings } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { ListingRow } from "./listing-row";

export const metadata = { title: "Listings | Reales CRM" };

export default async function Listings() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "listing.read")) return <NoAccess />;
  const listings: any[] = await listListings(getSequelize(), ctx, { limit: 100, offset: 0 });
  return (
    <section>
      <h1 className="text-2xl font-semibold">Listings</h1>
      <p className="muted text-sm">Publishing is blocked until the permit, brokerage licence and required fields pass the jurisdiction rules.</p>
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Title</th><th>Purpose</th><th>Price</th><th>Jurisdiction</th><th>Status</th><th>Compliance</th></tr></thead>
          <tbody>
            {listings.map((l) => (
              <ListingRow key={l.id} listing={{ id: l.id, title: l.title ?? "(untitled)", purpose: l.purpose, price: l.price ? `${l.currency} ${Number(l.price).toLocaleString("en-US")}` : "-", jurisdiction: l.jurisdictionCode, status: l.status }} canPublish={can(ctx, "listing.publish", { ownerUserId: l.agentUserId, branchId: l.branchId, projectId: l.projectId })} />
            ))}
            {listings.length === 0 && <tr><td colSpan={6} className="muted">No listings yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
