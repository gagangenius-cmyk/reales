import Link from "next/link";
import { QueryTypes } from "sequelize";
import { getSequelize } from "@reales/database";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { LogoutButton } from "./logout-button";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  const [t] = await getSequelize().query<{ name: string; jurisdiction: string }>("SELECT name, jurisdiction FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, type: QueryTypes.SELECT });
  const nav = [
    { href: "/dashboard", label: "Dashboard", show: true },
    { href: "/leads", label: "Leads", show: hasPermission(ctx, "lead.read") },
    { href: "/contacts", label: "Contacts", show: hasPermission(ctx, "contact.read") },
    { href: "/inventory", label: "Inventory", show: hasPermission(ctx, "inventory.read") || hasPermission(ctx, "inventory.manage") },
    { href: "/listings", label: "Listings", show: hasPermission(ctx, "listing.read") },
    { href: "/viewings", label: "Viewings", show: hasPermission(ctx, "viewing.read") },
    { href: "/inbox", label: "Inbox", show: hasPermission(ctx, "inbox.read") },
    { href: "/templates", label: "Templates", show: hasPermission(ctx, "template.read") },
    { href: "/campaigns", label: "Campaigns", show: hasPermission(ctx, "campaign.read") },
    { href: "/automation", label: "Automation", show: hasPermission(ctx, "workflow.read") },
    { href: "/deals", label: "Deals", show: hasPermission(ctx, "deal.read") },
    { href: "/finance", label: "Finance", show: hasPermission(ctx, "finance.read") || hasPermission(ctx, "commission.read") },
    { href: "/projects", label: "Projects", show: hasPermission(ctx, "project.read") },
    { href: "/organization", label: "Organization", show: hasPermission(ctx, "org.read") },
    { href: "/users", label: "Users", show: hasPermission(ctx, "user.read") },
    { href: "/audit", label: "Audit log", show: hasPermission(ctx, "audit.read") },
  ].filter((n) => n.show);
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row">
      <aside className="md:w-56">
        <div className="mb-4">
          <p className="font-semibold">{t?.name}</p>
          <p className="muted text-xs">{t?.jurisdiction}</p>
        </div>
        <nav className="flex flex-wrap gap-2 md:flex-col" aria-label="Main">
          {nav.map((n) => <Link key={n.href} href={n.href} className="btn-ghost text-sm">{n.label}</Link>)}
        </nav>
        <div className="mt-6"><LogoutButton /></div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
