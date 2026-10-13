import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listCampaigns } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";

export const metadata = { title: "Campaigns | Reales CRM" };

export default async function Campaigns() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "campaign.read")) return <NoAccess />;
  const campaigns: any[] = await listCampaigns(getSequelize(), ctx);
  return (
    <section>
      <h1 className="text-2xl font-semibold">Campaigns</h1>
      <p className="muted text-sm">Broadcasts snapshot their audience and re-check consent at send time. Create them through the API or the segment and template tools.</p>
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Name</th><th>Channel</th><th>Status</th><th>Scheduled</th><th></th></tr></thead>
          <tbody>
            {campaigns.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.channel}</td><td>{c.status}</td><td>{c.scheduledAt ? new Date(c.scheduledAt).toISOString().slice(0, 16).replace("T", " ") : "-"}</td><td><Link className="btn-ghost text-xs" href={`/campaigns/${c.id}`}>Open</Link></td></tr>)}
            {campaigns.length === 0 && <tr><td colSpan={5} className="muted">No campaigns yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
