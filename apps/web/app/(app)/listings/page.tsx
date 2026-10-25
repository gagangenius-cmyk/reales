import Link from "next/link";
import { getSequelize } from "@reales/database";
import { redirect } from "next/navigation";
import { AMENITIES, AMENITY_GROUPS, EMIRATES, PROPERTY_TYPES, listLocations, listAssignableUsers, listInventoryTree, listUnits, searchListingsAdvanced, listingParams, listingPins, smartListingQuery, type ListingFilters } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { ActiveChips, Check, Field, Num, Sel, SortTh, ViewTabs, date, num, pick, qs } from "@/components/filter-bits";
import { LiveSearch } from "@/components/live-search";
import { LazyMap } from "@/components/map-lazy";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { ListingDrawer } from "./listing-drawer";
import { ListingsTable } from "./listings-table";

export const metadata = { title: "Listings | Reales CRM" };

const PAGE = 25;
const TYPES = ["apartment", "villa", "townhouse", "penthouse", "duplex", "hotel_apartment", "studio", "compound", "full_floor", "half_floor", "whole_building", "bulk_units", "office", "retail", "showroom", "warehouse", "factory", "labour_camp", "staff_accommodation", "land", "farm"] as const;
const SORTS = ["newest", "oldest", "price_asc", "price_desc", "views", "enquiries", "expiry"] as const;
type SP = Record<string, string | undefined>;
const KEYS = ["view", "said", "q", "status", "purpose", "type", "bedsMin", "bedsMax", "minPrice", "maxPrice", "community", "agent", "featured", "exclusivity", "expiring", "noPhotos", "permit", "web", "furnishing", "from", "to", "stale", "enq", "sort"];

export default async function Listings({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "listing.read")) return <NoAccess />;
  const sp = await searchParams;
  if (sp.smart?.trim()) {
    // "2 bed apartment in marina under 2m": read the sentence into ordinary filters and show them as such
    const sm = await smartListingQuery(getSequelize(), ctx, sp.smart);
    redirect(`/listings${qs({ ...listingParams(sm.filters), said: sp.smart.trim().slice(0, 120) })}`);
  }
  const page = Math.max(1, Number(sp.page) || 1);
  const filters: ListingFilters = {
    q: sp.q?.trim() || undefined, status: pick(sp.status, ["draft", "published", "unpublished", "expired", "closed", "archived"]), purpose: pick(sp.purpose, ["sale", "rent"]), types: pick(sp.type, TYPES) ? [sp.type!] : undefined,
    bedsMin: num(sp.bedsMin), bedsMax: num(sp.bedsMax), minPrice: num(sp.minPrice), maxPrice: num(sp.maxPrice), community: sp.community?.trim() || undefined, agentId: sp.agent && (sp.agent === "me" || /^[0-9a-f-]{36}$/i.test(sp.agent)) ? sp.agent : undefined,
    featured: sp.featured === "1" || undefined, exclusivity: pick(sp.exclusivity, ["exclusive", "non_exclusive", "none"]), expiringInDays: num(sp.expiring), noPhotos: sp.noPhotos === "1" || undefined, permit: pick(sp.permit, ["missing", "expiring", "valid"]),
    onWebsite: sp.web === "1" || undefined, furnishing: pick(sp.furnishing, ["unfurnished", "semi_furnished", "furnished"]), createdFrom: date(sp.from), createdTo: date(sp.to), staleDays: num(sp.stale), hasEnquiries: sp.enq === "1" || undefined,
    sort: pick(sp.sort, SORTS) ?? "newest", limit: PAGE, offset: (page - 1) * PAGE,
  };
  const sq = getSequelize();
  const manage = hasPermission(ctx, "listing.manage");
  const readInv = hasPermission(ctx, "inventory.read") || hasPermission(ctx, "inventory.manage");
  const locationOpts = manage ? (await listLocations(sq, ctx).catch(() => [])).map((l: any) => ({ emirate: l.emirate, community: l.community, subCommunity: l.subCommunity, latitude: l.latitude, longitude: l.longitude })) : [];
  const [res, agents, tree, units] = await Promise.all([
    searchListingsAdvanced(sq, ctx, filters),
    manage || hasPermission(ctx, "listing.read") ? listAssignableUsers(sq, ctx).catch(() => []) : Promise.resolve([]),
    manage && readInv ? listInventoryTree(sq, ctx) : Promise.resolve(null),
    manage && readInv ? (listUnits(sq, ctx, { limit: 200, offset: 0, status: "available" }) as Promise<any[]>) : Promise.resolve([]),
  ]);
  const bName = new Map<string, string>((tree?.buildings ?? []).map((b: any) => [b.id, `${b.name}${b.community ? `, ${b.community}` : ""}`]));
  const unitOpts = units.map((u: any) => ({ id: u.id, label: `${u.unitNumber} - ${bName.get(u.buildingId) ?? "Building"} - ${u.bedrooms ?? "?"} bed ${u.type}${u.listPrice ? ` - ${u.currency} ${Number(u.listPrice).toLocaleString("en-US")}` : ""}`, listPrice: u.listPrice ? Number(u.listPrice) : null, currency: u.currency }));
  const agentOpts = agents.map((a: any) => ({ id: a.id, email: a.email }));
  const mapView = sp.view === "map";
  const mapData = mapView ? await listingPins(sq, ctx, { ...filters, limit: undefined, offset: undefined }) : null;
  const pages = Math.max(1, Math.ceil(res.total / PAGE));
  const current: SP = Object.fromEntries(KEYS.map((k) => [k, sp[k]]));
  const href = (over: SP) => `/listings${qs({ ...current, ...over })}`;
  const sortHref = (s: string) => href({ sort: s, page: undefined });
  const advancedKeys = KEYS.filter((k) => !["view", "said", "q", "status", "purpose", "sort"].includes(k));
  const advancedOn = advancedKeys.some((k) => sp[k]);
  const label: Record<string, string> = { said: "Smart search", q: "Search", status: "Status", purpose: "Purpose", type: "Type", bedsMin: "Beds from", bedsMax: "Beds to", minPrice: "Min price", maxPrice: "Max price", community: "Community", agent: "Agent", featured: "Featured", exclusivity: "Exclusivity", expiring: "Expiring (days)", noPhotos: "No photos", permit: "Permit", web: "On website", furnishing: "Furnishing", from: "Created from", to: "Created to", stale: "Not refreshed (days)", enq: "Has enquiries" };
  const chips = KEYS.filter((k) => k !== "sort" && k !== "view" && sp[k]).map((k) => ({ label: `${label[k]}${["featured", "noPhotos", "web", "enq"].includes(k) ? "" : `: ${sp[k]}`}`, href: href({ [k]: undefined, page: undefined }) }));
  const chip = (active: boolean) => (active ? "btn" : "btn-ghost");
  const rows = res.rows.map((l: any) => {
    const scope = { ownerUserId: l.agentUserId, branchId: l.branchId, projectId: l.projectId };
    return {
      data: { id: l.id, reference: l.reference ?? "", title: l.title ?? "(untitled)", purpose: l.purpose, price: l.price ? `${l.currency} ${Number(l.price).toLocaleString("en-US")}` : "-", jurisdiction: l.jurisdictionCode, status: l.status,
        unit: l.unit ? `${l.unit.unitNumber}${l.unit.building ? ` - ${l.unit.building}` : ""}${l.unit.bedrooms != null ? ` - ${l.unit.bedrooms} bed` : ""}` : "-", photos: l.photoCount ?? 0, views: Number(l.viewCount ?? 0), enquiries: Number(l.enquiryCount ?? 0), featured: !!l.featured, web: !!l.shareEnabled, expiresOn: l.expiresOn ?? null },
      canPublish: can(ctx, "listing.publish", scope),
      edit: can(ctx, "listing.manage", scope) ? { target: { id: l.id, title: l.title ?? "", description: l.description ?? "", price: l.price ? Number(l.price) : null, agentUserId: l.agentUserId }, agents: agentOpts, canReassign: can(ctx, "lead.assign") } : undefined,
    };
  });
  const head = (
    <>
      <SortTh label="Listing" sort={filters.sort} asc="oldest" desc="newest" href={sortHref} /><th>Unit</th><th>Purpose</th><SortTh label="Price" sort={filters.sort} asc="price_asc" desc="price_desc" href={sortHref} />
      <SortTh label="Media and reach" sort={filters.sort} asc="enquiries" desc="views" href={sortHref} /><th>Status</th><SortTh label="Expires" sort={filters.sort} asc="expiry" desc="expiry" href={sortHref} /><th />
    </>
  );
  return (
    <section>
      <div className="page-head">
        <div><h1>Listings</h1><p className="muted text-sm">{res.total} listing{res.total === 1 ? "" : "s"}. Tick listings to create a client PDF or act on several at once. Publishing is blocked until the permit, brokerage licence and required fields pass the jurisdiction rules.</p></div>
        <div className="flex items-center gap-3"><ViewTabs base="/listings" active={mapView ? "map" : "list"} extra={[{ key: "map", label: "Map", href: href({ view: "map", page: undefined }) }]} />{manage && <ListingDrawer mode="create" units={unitOpts} agents={agentOpts} amenities={AMENITIES} groups={AMENITY_GROUPS} locations={locationOpts} emirates={[...EMIRATES]} types={PROPERTY_TYPES.map((t) => ({ ...t }))} />}</div>
      </div>
      <form className="card mb-3 flex flex-wrap items-center gap-3 p-3" action="/listings" aria-label="Smart search">
        <label className="grow text-sm"><span className="muted text-xs font-medium">Smart search: describe what you are looking for</span><input className="input mt-1" name="smart" placeholder="2 bed apartment in Dubai Marina under 2m, furnished studio for rent below 80k..." defaultValue={sp.said ?? ""} /></label>
        <button className="btn self-end">Find</button>
      </form>
      <form className="card mb-3 flex flex-col gap-3 p-3" action="/listings">
        {filters.sort !== "newest" && <input type="hidden" name="sort" value={filters.sort} />}{sp.view === "map" && <input type="hidden" name="view" value="map" />}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Search" wide><LiveSearch placeholder="Title, reference, unit number, building or community" /></Field>
          <Field label="Status"><Sel name="status" value={filters.status} any="All" options={["draft", "published", "unpublished", "expired", "closed", "archived"]} /></Field>
          <Field label="Purpose"><Sel name="purpose" value={filters.purpose} any="All" options={["sale", "rent"]} /></Field>
          <button className="btn">Filter</button>{(chips.length > 0) && <Link className="btn-ghost" href="/listings">Clear all</Link>}
        </div>
        <details open={advancedOn}>
          <summary className="cursor-pointer text-sm font-medium">Advanced filters</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Property type"><Sel name="type" value={sp.type} options={[...TYPES]} /></Field>
            <Field label="Bedrooms from"><Num name="bedsMin" value={filters.bedsMin} /></Field>
            <Field label="Bedrooms to"><Num name="bedsMax" value={filters.bedsMax} /></Field>
            <Field label="Community or area"><input className="input" name="community" defaultValue={sp.community ?? ""} /></Field>
            <Field label="Min price (AED)"><Num name="minPrice" value={filters.minPrice} /></Field>
            <Field label="Max price (AED)"><Num name="maxPrice" value={filters.maxPrice} /></Field>
            <Field label="Furnishing"><Sel name="furnishing" value={filters.furnishing} options={[["unfurnished", "Unfurnished"], ["semi_furnished", "Semi-furnished"], ["furnished", "Furnished"]]} /></Field>
            <Field label="Agent"><Sel name="agent" value={sp.agent} options={[["me", "Mine"], ...agentOpts.map((a: any): [string, string] => [a.id, a.email])]} /></Field>
            <Field label="Exclusivity"><Sel name="exclusivity" value={filters.exclusivity} options={[["exclusive", "Exclusive"], ["non_exclusive", "Non-exclusive"], ["none", "None"]]} /></Field>
            <Field label="Permit"><Sel name="permit" value={filters.permit} options={[["valid", "Valid"], ["expiring", "Expiring soon"], ["missing", "Missing or expired"]]} /></Field>
            <Field label="Listing expires within (days)"><Num name="expiring" value={filters.expiringInDays} /></Field>
            <Field label="Not refreshed for (days)"><Num name="stale" value={filters.staleDays} /></Field>
            <Field label="Created from"><input className="input" type="date" name="from" defaultValue={sp.from ?? ""} /></Field>
            <Field label="Created to"><input className="input" type="date" name="to" defaultValue={sp.to ?? ""} /></Field>
            <div className="flex flex-col justify-end gap-2"><Check name="featured" checked={!!filters.featured} label="Featured only" /><Check name="web" checked={!!filters.onWebsite} label="On public website" /></div>
            <div className="flex flex-col justify-end gap-2"><Check name="noPhotos" checked={!!filters.noPhotos} label="Missing photos" /><Check name="enq" checked={!!filters.hasEnquiries} label="Has enquiries" /></div>
          </div>
        </details>
      </form>
      <nav className="mb-3 flex flex-wrap gap-2 text-sm" aria-label="Quick filters">
        <Link className={chip(!filters.status && !filters.purpose)} href={href({ status: undefined, purpose: undefined, page: undefined })}>All</Link>
        {["published", "draft", "unpublished", "expired", "closed", "archived"].map((s) => <Link key={s} className={chip(filters.status === s)} href={href({ status: s, page: undefined })}>{s[0]!.toUpperCase() + s.slice(1)}</Link>)}
        <Link className={chip(filters.purpose === "sale")} href={href({ purpose: "sale", page: undefined })}>Sale</Link><Link className={chip(filters.purpose === "rent")} href={href({ purpose: "rent", page: undefined })}>Rent</Link>
        <Link className={chip(sp.agent === "me")} href={href({ agent: "me", page: undefined })}>Mine</Link>
      </nav>
      <div className="mb-3"><ActiveChips chips={chips} /></div>
      {mapData && (
        <div className="mb-4 flex flex-col gap-2">
          <LazyMap height={460} pins={mapData.pins.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, title: p.title, subtitle: `${p.reference ?? ""} - ${[p.bedrooms != null ? `${p.bedrooms} bed` : null, p.type, p.community].filter(Boolean).join(", ")}`, href: `/listings/${p.id}`, image: p.cover ? `/api/v1/listings/${p.id}/media/${p.cover}` : null, precise: p.precise, label: p.price ? `${p.currency} ${p.price >= 1_000_000 ? `${(p.price / 1_000_000).toFixed(p.price % 1_000_000 ? 2 : 0)}M` : `${Math.round(p.price / 1000)}K`}` : "?" }))} />
          <p className="muted text-xs">Showing {mapData.pins.length} of {mapData.total} matching listings{mapData.withoutLocation > 0 ? `; ${mapData.withoutLocation} have no location yet` : ""}. Faded pins are placed at the community centre because no exact pin was set. The filters above apply to the map too.</p>
        </div>
      )}
      <ListingsTable rows={rows} head={head} agents={agentOpts} canBulk={manage || hasPermission(ctx, "listing.publish")} canPdf defaults={{ clientName: sp.client, leadId: sp.lead && /^[0-9a-f-]{36}$/i.test(sp.lead) ? sp.lead : undefined }} />
      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="muted">Page {page} of {pages}</span>
          <div className="flex gap-2">{page > 1 && <Link className="btn-ghost" href={href({ page: String(page - 1) })}>Previous</Link>}{page < pages && <Link className="btn-ghost" href={href({ page: String(page + 1) })}>Next</Link>}</div>
        </nav>
      )}
    </section>
  );
}
