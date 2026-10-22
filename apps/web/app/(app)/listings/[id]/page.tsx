import Link from "next/link";
import { getSequelize } from "@reales/database";
import { AMENITIES, AMENITY_GROUPS, getListingChannels, getListingDetail, getSiteSettings } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { ListingWorkspace } from "./listing-workspace";

export const metadata = { title: "Listing | Reales CRM" };

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "listing.read")) return <NoAccess />;
  const { id } = await params;
  const sq = getSequelize();
  let l: any;
  try { l = await getListingDetail(sq, ctx, id); } catch { return <section><h1 className="text-2xl font-semibold">Listing not found</h1><Link className="btn-ghost mt-3 inline-block" href="/listings">Back to listings</Link></section>; }
  const ref = { ownerUserId: l.agentUserId, branchId: l.branchId, projectId: l.projectId };
  const [channels, site] = await Promise.all([
    getListingChannels(sq, ctx, id).catch(() => []),
    hasPermission(ctx, "site.manage") ? getSiteSettings(sq, ctx).catch(() => null) : Promise.resolve(null),
  ]);
  const clean = JSON.parse(JSON.stringify(l));
  return (
    <section className="flex flex-col gap-4">
      <div><Link className="muted text-sm" href="/listings">&larr; Listings</Link></div>
      <ListingWorkspace
        l={clean} channels={channels as any[]} amenities={AMENITIES} groups={AMENITY_GROUPS}
        canManage={can(ctx, "listing.manage", ref)} canPublish={can(ctx, "listing.publish", ref)}
        site={site ? { slug: site.slug, enabled: !!site.settings?.enabled } : null}
      />
    </section>
  );
}
