import Link from "next/link";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";

export default async function HrLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  const read = hasPermission(ctx, "hr.read"), manage = hasPermission(ctx, "hr.manage");
  const tabs = [
    { href: "/hr", label: "Home", show: true }, { href: "/hr/employees", label: "Employees", show: read }, { href: "/hr/attendance", label: "Attendance", show: true },
    { href: "/hr/leave", label: "Leave", show: true }, { href: "/hr/letters", label: "Letters", show: hasPermission(ctx, "hr.letters") }, { href: "/hr/documents", label: "Documents", show: true },
    { href: "/hr/noticeboard", label: "Noticeboard", show: true }, { href: "/hr/setup", label: "Setup", show: manage },
  ].filter((t) => t.show);
  return (
    <div className="flex flex-col gap-5">
      <nav className="flex flex-wrap gap-2 border-b pb-3 text-sm" style={{ borderColor: "var(--border)" }} aria-label="HR sections">
        {tabs.map((t) => <Link key={t.href} className="btn-ghost" href={t.href}>{t.label}</Link>)}
      </nav>
      {children}
    </div>
  );
}
