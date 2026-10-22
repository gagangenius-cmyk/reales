import { getSequelize } from "@reales/database";
import { getConfig } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { ConfigClient } from "./config-client";

export const metadata = { title: "Modules and automation | Reales CRM" };

export default async function Modules() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "tenant.manage")) return <NoAccess />;
  const cfg = await getConfig(getSequelize(), ctx);
  return (
    <section className="flex flex-col gap-6">
      <div className="page-head"><div><h1>Modules and automation</h1><p className="muted text-sm">Turn whole areas of the CRM on or off for your company, and tune how the ones you keep behave. A module that is off disappears from the menu and its pages and API stop working. Data is kept and returns when you turn it back on.</p></div></div>
      <ConfigClient modules={cfg.modules} settings={cfg.settings as any} />
    </section>
  );
}
