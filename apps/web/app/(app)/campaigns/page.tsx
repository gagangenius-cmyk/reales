import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listCampaigns } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";

export const metadata = { title: "Broadcasts | Reales CRM" };

const tone: Record<string, string> = { draft: "badge-gray", scheduled: "", preparing: "badge-warn", running: "badge-ok", paused: "badge-warn", completed: "badge-ok", failed: "badge-danger", cancelled: "badge-gray" };

export default async function Campaigns({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "campaign.read")) return <NoAccess />;
  const sp = await searchParams;
  const all: any[] = await listCampaigns(getSequelize(), ctx);
  const campaigns = sp.status ? all.filter((c) => c.status === sp.status) : all;
  const count = (s: string) => all.filter((c) => c.status === s).length;
  const tiles = [["Running", count("running")], ["Scheduled", count("scheduled")], ["Drafts", count("draft")], ["Completed", count("completed")]] as const;
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head">
        <div><h1>Broadcasts</h1><p className="muted text-sm">Bulk WhatsApp, email and SMS. The audience is snapshotted, consent is re-checked at send time, and sending is throttled.</p></div>
        {hasPermission(ctx, "campaign.manage") && <Link className="btn" href="/campaigns/new">+ New broadcast</Link>}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">{tiles.map(([l, v]) => <div key={l} className="card stat"><span className="muted text-xs">{l}</span><b>{v}</b></div>)}</div>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Status filter">
        <Link className={!sp.status ? "btn" : "btn-ghost"} href="/campaigns">All</Link>
        {["draft", "scheduled", "running", "paused", "completed", "failed", "cancelled"].map((s) => <Link key={s} className={sp.status === s ? "btn" : "btn-ghost"} href={`/campaigns?status=${s}`}>{s}</Link>)}
      </nav>
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr><th>Name</th><th>Channel</th><th>Status</th><th>Scheduled</th><th>Throttle</th><th /></tr></thead>
          <tbody>
            {campaigns.map((c) => <tr key={c.id}><td className="font-medium">{c.name}</td><td><span className="badge badge-gray">{c.channel}</span></td><td><span className={`badge ${tone[c.status] ?? ""}`}>{c.status}</span></td><td>{c.scheduledAt ? new Date(c.scheduledAt).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) : "-"}</td><td>{c.maxPerMinute}/min</td><td className="text-right"><Link className="btn-ghost text-xs" href={`/campaigns/${c.id}`}>Open</Link></td></tr>)}
            {campaigns.length === 0 && <tr><td colSpan={6} className="muted">No broadcasts yet. Create the first one.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
