import { getSequelize } from "@reales/database";
import { HR_DOC_CATEGORIES, listEmployees, listHrDocuments } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { DocsClient } from "./docs-client";

export const metadata = { title: "HR documents | Reales CRM" };

export default async function Documents({ searchParams }: { searchParams: Promise<{ employee?: string; category?: string; expiring?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const sq = getSequelize();
  const manage = hasPermission(ctx, "hr.manage");
  const [docs, emps] = await Promise.all([
    listHrDocuments(sq, ctx, { employeeId: sp.employee, category: sp.category, expiringWithinDays: sp.expiring ? Number(sp.expiring) : undefined }),
    manage ? listEmployees(sq, ctx, { limit: 200 }) : Promise.resolve(null),
  ]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>HR documents</h1><p className="muted text-sm">{manage ? "Contracts, IDs, visas, insurance and company policies. Employees see their own documents and anything shared with the whole company." : "Your documents and the company policies."}</p></div></div>
      <DocsClient docs={docs as never} employees={(emps?.rows ?? []).map((e: any) => ({ id: e.id, name: e.fullName }))} categories={HR_DOC_CATEGORIES} canManage={manage} employee={sp.employee} category={sp.category} expiring={sp.expiring} />
    </section>
  );
}
