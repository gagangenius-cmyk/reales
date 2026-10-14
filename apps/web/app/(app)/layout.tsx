import Link from "next/link";
import { redirect } from "next/navigation";
import { QueryTypes } from "sequelize";
import { getSequelize } from "@reales/database";
import { countMyUnread } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { LogoutButton } from "./logout-button";
import { LanguageSwitch } from "@/components/language-switch";
import { getLang, translate } from "@/lib/i18n";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  const lang = await getLang();
  // Owner/tenant portal accounts have no CRM access: send them to their own page.
  if (ctx.grants.length > 0 && ctx.grants.every((g) => g.permission === "portal.access")) redirect("/portal");
  const [t] = await getSequelize().query<{ name: string; jurisdiction: string }>("SELECT name, jurisdiction FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, type: QueryTypes.SELECT });
  const unread = await countMyUnread(getSequelize(), ctx).catch(() => 0);
  const nav = [
    { href: "/notifications", label: unread ? `Notifications (${unread})` : "Notifications", show: true },
    { href: "/dashboard", label: "Dashboard", show: true },
    { href: "/calendar", label: "Calendar", show: true },
    { href: "/tasks", label: "Tasks", show: true },
    { href: "/leads", label: "Leads", show: hasPermission(ctx, "lead.read") },
    { href: "/contacts", label: "Contacts", show: hasPermission(ctx, "contact.read") },
    { href: "/inventory", label: "Inventory", show: hasPermission(ctx, "inventory.read") || hasPermission(ctx, "inventory.manage") },
    { href: "/listings", label: "Listings", show: hasPermission(ctx, "listing.read") },
    { href: "/searches", label: "Saved searches", show: hasPermission(ctx, "match.read") },
    { href: "/valuation", label: "Valuation", show: hasPermission(ctx, "valuation.run") },
    { href: "/referrals", label: "Referrals", show: hasPermission(ctx, "referral.read") },
    { href: "/viewings", label: "Viewings", show: hasPermission(ctx, "viewing.read") },
    { href: "/inbox", label: "Inbox", show: hasPermission(ctx, "inbox.read") },
    { href: "/templates", label: "Templates", show: hasPermission(ctx, "template.read") },
    { href: "/campaigns", label: "Campaigns", show: hasPermission(ctx, "campaign.read") },
    { href: "/bots", label: "Bots", show: hasPermission(ctx, "bot.read") },
    { href: "/automation", label: "Automation", show: hasPermission(ctx, "workflow.read") },
    { href: "/deals", label: "Deals", show: hasPermission(ctx, "deal.read") },
    { href: "/finance", label: "Finance", show: hasPermission(ctx, "finance.read") || hasPermission(ctx, "commission.read") },
    { href: "/portfolios", label: "Portfolios", show: hasPermission(ctx, "portfolio.read") },
    { href: "/leases", label: "Leases", show: hasPermission(ctx, "lease.read") },
    { href: "/maintenance", label: "Maintenance", show: hasPermission(ctx, "maintenance.read") },
    { href: "/compliance", label: "Compliance", show: hasPermission(ctx, "kyc.read") || hasPermission(ctx, "case.read") || hasPermission(ctx, "dsr.manage") },
    { href: "/inspections", label: "Inspections", show: hasPermission(ctx, "inspection.read") },
    { href: "/projects", label: "Projects", show: hasPermission(ctx, "project.read") },
    { href: "/organization", label: "Organization", show: hasPermission(ctx, "org.read") },
    { href: "/portal-access", label: "Portal access", show: hasPermission(ctx, "portaluser.manage") },
    { href: "/imports", label: "Import / export", show: hasPermission(ctx, "import.manage") || hasPermission(ctx, "export.data") },
    { href: "/users", label: "Users", show: hasPermission(ctx, "user.read") },
    { href: "/settings", label: "Settings", show: hasPermission(ctx, "sso.manage") || hasPermission(ctx, "dataprocessing.manage") || hasPermission(ctx, "usage.read") },
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
          {nav.map((n) => <Link key={n.href} href={n.href} className="btn-ghost text-sm">{n.href === "/notifications" && unread ? `${translate(lang, "Notifications")} (${unread})` : translate(lang, n.label)}</Link>)}
        </nav>
        <div className="mt-6 flex flex-wrap gap-2"><LogoutButton /><LanguageSwitch lang={lang} /></div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
