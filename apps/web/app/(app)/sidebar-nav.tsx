"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell, LayoutDashboard, CalendarDays, CheckSquare, Users, Contact, Building2, Home, Search, Calculator, Handshake, Eye, Inbox, FileText, Megaphone, Bot,
  Workflow, FileSignature, Wallet, Briefcase, KeyRound, Wrench, ShieldCheck, ClipboardCheck, FolderKanban, Network, UserCog, Upload, Settings, ScrollText, BarChart3, Banknote, LifeBuoy, PlugZap, Phone, Target, ListChecks, Globe, Rss, Trash2, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "/notifications": Bell, "/dashboard": LayoutDashboard, "/calendar": CalendarDays, "/tasks": CheckSquare, "/leads": Users, "/contacts": Contact,
  "/inventory": Building2, "/listings": Home, "/searches": Search, "/valuation": Calculator, "/referrals": Handshake, "/viewings": Eye, "/inbox": Inbox,
  "/templates": FileText, "/campaigns": Megaphone, "/broadcasts": Megaphone, "/bots": Bot, "/automation": Workflow, "/deals": FileSignature, "/finance": Wallet,
  "/portfolios": Briefcase, "/leases": KeyRound, "/maintenance": Wrench, "/compliance": ShieldCheck, "/inspections": ClipboardCheck, "/projects": FolderKanban,
  "/organization": Network, "/portal-access": UserCog, "/imports": Upload, "/users": UserCog, "/settings": Settings, "/audit": ScrollText, "/availability": CalendarDays, "/roles": KeyRound, "/insights": BarChart3, "/agents": UserCog, "/commissions": Wallet, "/targets": Target, "/pools": Inbox, "/payouts": Banknote, "/noticeboard": Megaphone, "/support": LifeBuoy, "/lead-sources": PlugZap, "/calls": Phone, "/checklists": ListChecks, "/distribution": Rss, "/website": Globe, "/trash": Trash2,
};

export type NavGroup = { title: string; items: { href: string; label: string; count?: number }[] };

export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="pb-6">
      {groups.filter((g) => g.items.length).map((g) => (
        <div key={g.title} className="nav-group">
          <p className="nav-title">{g.title}</p>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((n) => {
              const Icon = ICONS[n.href] ?? FolderKanban;
              const active = path === n.href || path.startsWith(n.href + "/");
              return (
                <li key={n.href}>
                  <Link href={n.href} className="nav-link" aria-current={active ? "page" : undefined}>
                    <Icon size={17} aria-hidden strokeWidth={1.8} />
                    <span>{n.label}</span>
                    {n.count ? <span className="nav-count">{n.count}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
