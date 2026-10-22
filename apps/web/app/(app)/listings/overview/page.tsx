import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listingsOverview } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { BarList, Donut } from "@/components/charts";
import { ViewTabs } from "@/components/filter-bits";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";

export const metadata = { title: "Listings overview | Reales CRM" };
const aed = (n: number) => (n >= 1_000_000 ? `AED ${(n / 1_000_000).toFixed(1)}M` : `AED ${Math.round(n).toLocaleString("en-US")}`);

export default async function ListingsOverview() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "listing.read")) return <NoAccess />;
  const o = await listingsOverview(getSequelize(), ctx);
  const t = o.totals;
  const stat = (label: string, value: string | number, href: string, warn = false, sub?: string) => (
    <Link href={href} className="card stat transition hover:-translate-y-0.5 hover:shadow-md"><span className="muted text-xs">{label}</span><b className={warn && Number(value) > 0 ? "err" : ""}>{value}</b>{sub && <span className="muted text-xs">{sub}</span>}</Link>
  );
  const att = (title: string, rows: { id: string; ref: string; title: string; why: string }[], href: string) => (
    <div className="card p-4"><div className="mb-2 flex items-baseline justify-between"><h3 className="font-semibold">{title}</h3><Link className="text-xs" href={href}>View all</Link></div>
      {rows.length === 0 ? <p className="muted text-sm">Nothing here.</p> : <ul className="flex flex-col gap-1.5 text-sm">{rows.map((r) => <li key={r.id}><Link href={`/listings/${r.id}`}>{r.title}</Link><span className="muted"> {r.ref} - {r.why}</span></li>)}</ul>}</div>
  );
  const top = (rows: typeof o.topViewed) => rows.length === 0 ? <p className="muted text-sm">No activity yet.</p> : <BarList data={rows.map((r) => ({ label: `${r.title} (${r.ref})`, value: r.views, hint: `${r.enquiries} enquiries` }))} />;
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Listings overview</h1><p className="muted text-sm">Stock, market time, quality and reach across the listings you can see.</p></div><ViewTabs base="/listings" active="overview" /></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stat("Published", t.published, "/listings?status=published", false, `${t.all} in total, ${t.draft} drafts`)}
        {stat("Live value", aed(t.liveValue), "/listings?status=published&sort=price_desc")}
        {stat("On public website", t.onWebsite, "/listings?web=1")}
        {stat("Featured / exclusive", `${t.featured} / ${t.exclusive}`, "/listings?featured=1")}
        {stat("Views", t.views.toLocaleString("en-US"), "/listings?sort=views")}
        {stat("Enquiries", t.enquiries, "/listings?enq=1&sort=enquiries", false, t.enquiryRate === null ? undefined : `${(t.enquiryRate * 100).toFixed(1)}% of views`)}
        {stat("Average quality", t.avgQuality === null ? "-" : `${t.avgQuality}/100`, "/listings")}
        {stat("Average days on market", t.avgDaysOnMarket ?? "-", "/listings?status=published&sort=oldest")}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4"><h3 className="mb-3 font-semibold">By status</h3><Donut data={o.byStatus} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Sale and rent</h3><Donut data={o.byPurpose} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Property type</h3><BarList data={o.byType} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Top communities</h3><BarList data={o.byCommunity} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Published price bands</h3><BarList data={o.priceBands} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Time on market</h3><BarList data={o.age} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Listing quality</h3><BarList data={o.quality} /></div>
        <div className="card p-4"><h3 className="mb-3 font-semibold">Most viewed</h3>{top(o.topViewed)}</div>
      </div>
      <h2 className="text-lg font-semibold">Needs attention</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {att("No photos", o.attention.noPhotos, "/listings?noPhotos=1")}
        {att("No valid permit", o.attention.noPermit, "/listings?status=published&permit=missing")}
        {att("Permit expiring within 30 days", o.attention.permitExpiring, "/listings?permit=expiring")}
        {att("Listing expiring within 7 days", o.attention.expiring, "/listings?expiring=7")}
        {att("Not refreshed for 30+ days", o.attention.stale, "/listings?stale=30")}
        {att("Low quality score", o.attention.lowQuality, "/listings?status=published&sort=oldest")}
      </div>
    </section>
  );
}
