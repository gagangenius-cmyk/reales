import Link from "next/link";
import { getSequelize } from "@reales/database";
import { broadcastSetup, listProjects } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { BroadcastWizard } from "./wizard";

export const metadata = { title: "New broadcast | Reales CRM" };

export default async function NewBroadcast() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "campaign.manage")) return <NoAccess />;
  const sq = getSequelize();
  const [setup, projects] = await Promise.all([broadcastSetup(sq, ctx), hasPermission(ctx, "project.read") ? (listProjects(sq, ctx) as Promise<any[]>) : Promise.resolve([])]);
  return (
    <section>
      <div className="page-head"><div><Link className="muted text-sm" href="/campaigns">&larr; Broadcasts</Link><h1>New broadcast</h1><p className="muted text-sm">Pick an audience and an approved template. Consent is re-checked for every recipient at send time.</p></div></div>
      <BroadcastWizard setup={setup} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
    </section>
  );
}
