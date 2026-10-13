import Link from "next/link";
import { getSequelize } from "@reales/database";
import { campaignFunnel, getCampaign } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { CampaignControls } from "./controls";

export const metadata = { title: "Campaign | Reales CRM" };

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "campaign.read")) return <NoAccess />;
  const { id } = await params;
  const sq = getSequelize();
  let c: any, f: any;
  try { [c, f] = await Promise.all([getCampaign(sq, ctx, id), campaignFunnel(sq, ctx, id)]); } catch {
    return <section><h1 className="text-2xl font-semibold">Campaign not found</h1><Link className="btn-ghost mt-3 inline-block" href="/campaigns">Back</Link></section>;
  }
  const steps = [["Sent", f.sent], ["Delivered", f.delivered], ["Replied", f.replied], ["Leads", f.leads], ["Viewings", f.viewings], ["Deals", f.deals]] as const;
  return (
    <section className="flex flex-col gap-4">
      <div><Link className="muted text-sm" href="/campaigns">Back to campaigns</Link><h1 className="text-2xl font-semibold">{c.name}</h1><p className="muted text-sm">{c.channel} - status {c.status}</p></div>
      {can(ctx, "campaign.manage") && <CampaignControls id={c.id} status={c.status} />}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {steps.map(([l, v]) => <div key={l} className="card p-3"><p className="muted text-xs uppercase">{l}</p><p className="text-2xl font-semibold">{v}</p></div>)}
      </div>
      <div className="card p-4">
        <h2 className="font-semibold">Audience outcome</h2>
        <p className="muted text-sm">{Object.entries(c.stats).map(([k, v]) => `${k}: ${v}`).join(" - ") || "Not prepared yet."}</p>
        {Object.keys(c.skippedByReason).length > 0 && <p className="mt-2 text-sm">Skipped: {Object.entries(c.skippedByReason).map(([k, v]) => `${k} (${v})`).join(", ")}</p>}
      </div>
    </section>
  );
}
