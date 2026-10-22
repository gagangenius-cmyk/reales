import { getSequelize } from "@reales/database";
import { getSiteSettings } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { SiteForm } from "./site-form";

export const metadata = { title: "Website | Reales CRM" };

export default async function Website() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "site.manage")) return <NoAccess />;
  const d = await getSiteSettings(getSequelize(), ctx);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Property website</h1><p className="muted text-sm">A public site for your listings: search, photos, floor plans, brochures and an enquiry form that creates a lead for the listing agent. Choose which listings appear from each listing&apos;s Distribution tab.</p></div></div>
      <SiteForm slug={d.slug} initial={JSON.parse(JSON.stringify(d.settings ?? {}))} tenantName={d.tenantName} />
    </section>
  );
}
