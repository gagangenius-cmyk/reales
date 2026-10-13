import { getSequelize } from "@reales/database";
import { hasPermission } from "@reales/rbac";
import { QueryTypes } from "sequelize";
import { requireContext } from "@/lib/page-context";

export const metadata = { title: "Dashboard | Reales CRM" };

export default async function Dashboard() {
  const ctx = await requireContext();
  const sq = getSequelize();
  const count = async (table: string) => {
    const [r] = await sq.query<{ n: number }>(`SELECT COUNT(*) n FROM \`${table}\` WHERE tenant_id=:t`, { replacements: { t: ctx.tenantId }, type: QueryTypes.SELECT });
    return Number(r?.n ?? 0);
  };
  const tiles = [
    hasPermission(ctx, "user.read") && { label: "Users", value: await count("users") },
    hasPermission(ctx, "project.read") && { label: "Projects", value: await count("projects") },
    hasPermission(ctx, "org.read") && { label: "Branches", value: await count("branches") },
    hasPermission(ctx, "audit.read") && { label: "Audit events", value: await count("audit_events") },
  ].filter(Boolean) as { label: string; value: number }[];
  return (
    <section>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="muted text-sm">Role-aware dashboards arrive with the CRM modules in the next phases.</p>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="card p-4"><p className="muted text-xs uppercase tracking-wide">{t.label}</p><p className="text-3xl font-semibold">{t.value}</p></div>
        ))}
      </div>
    </section>
  );
}
