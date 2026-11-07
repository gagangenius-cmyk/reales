import { getSequelize } from "@reales/database";
import { listListings, listPhotoshoots, listUsers } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { RequestForm, ShootActions } from "./photoshoot-client";

export const metadata = { title: "Photoshoots | Reales CRM" };

const STATUS = ["requested", "scheduled", "in_progress", "delivered", "cancelled"] as const;
const when = (v?: string | null) => (v ? new Date(v).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");

export default async function Photoshoots({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireContext();
  const sq = getSequelize();
  const sp = await searchParams;
  const status = (STATUS as readonly string[]).includes(sp.status ?? "") ? (sp.status as (typeof STATUS)[number]) : undefined;
  const manage = hasPermission(ctx, "photoshoot.manage"), request = hasPermission(ctx, "photoshoot.request");
  const [rows, listings, users]: [any[], any[], any[]] = await Promise.all([
    listPhotoshoots(sq, ctx, { status }),
    request && hasPermission(ctx, "listing.read") ? (listListings(sq, ctx, { limit: 200, offset: 0 }) as Promise<any[]>) : Promise.resolve([]),
    manage && hasPermission(ctx, "user.read") ? ((await listUsers(sq, ctx, { limit: 200, offset: 0 })) as any[]) : [],
  ]);
  const listingOpts = listings.map((l: any) => ({ id: l.id, title: `${l.reference ? l.reference + " - " : ""}${l.title ?? "Untitled"}` }));
  const people = users.map((u: any) => ({ id: u.id, email: u.email }));
  const link = (s?: string) => (s ? `/photoshoots?status=${s}` : "/photoshoots");
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Photoshoots</h1><p className="muted text-sm">Request photos, video, drone or floor plans for a listing, and follow them to delivery.</p></div>{request && <RequestForm listings={listingOpts} />}</div>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Status">
        <a className={!status ? "btn" : "btn-ghost"} href={link()}>All</a>
        {STATUS.map((s) => <a key={s} className={status === s ? "btn" : "btn-ghost"} href={link(s)}>{s.replace("_", " ")}</a>)}
      </nav>
      <div className="card overflow-x-auto p-0">
        <table className="t w-full text-sm">
          <thead><tr><th>Listing</th><th>What</th><th>Status</th><th>When</th><th>Photographer</th><th>Requested by</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><a className="underline-offset-2 hover:underline" href={`/listings/${r.listingId}`}>{r.listingTitle}</a>{r.accessNotes && <p className="muted text-xs">{r.accessNotes}</p>}</td>
                <td>{(r.shootTypes ?? []).join(", ").replace(/_/g, " ")}</td>
                <td><span className={`badge ${r.status === "delivered" ? "badge-ok" : r.status === "cancelled" ? "badge-danger" : "badge-warn"}`}>{r.status.replace("_", " ")}</span>{r.mediaCount ? <span className="muted text-xs"> · {r.mediaCount} files</span> : null}{r.cancelReason && <p className="muted text-xs">{r.cancelReason}</p>}</td>
                <td>{r.scheduledAt ? when(r.scheduledAt) : r.preferredDate ? `wants ${r.preferredDate}` : "-"}</td>
                <td>{r.photographerEmail ?? r.photographerName ?? "-"}</td>
                <td>{r.requestedByEmail}</td>
                <td><ShootActions row={{ id: r.id, status: r.status, mine: r.requestedBy === ctx.userId, assigned: r.photographerUserId === ctx.userId }} manage={manage} people={people} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="muted py-4 text-center">No photoshoots{status ? ` with status ${status.replace("_", " ")}` : ""}.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
