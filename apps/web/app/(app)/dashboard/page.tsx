import { getSequelize } from "@reales/database";
import { getDashboard, type DashboardKind } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { QueryTypes } from "sequelize";
import { requireContext } from "@/lib/page-context";

export const metadata = { title: "Dashboard | Reales CRM" };

type Tile = { label: string; value: string | number };

function Tiles({ title, tiles }: { title: string; tiles: Tile[] }) {
  return (
    <div>
      <h2 className="mb-2 font-semibold">{title}</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="card p-4"><p className="muted text-xs uppercase tracking-wide">{t.label}</p><p className="text-3xl font-semibold">{t.value}</p></div>
        ))}
      </div>
    </div>
  );
}

const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);

export default async function Dashboard() {
  const ctx = await requireContext();
  const sq = getSequelize();
  const dash = async (k: DashboardKind): Promise<any | null> => {
    try { return await getDashboard(sq, ctx, k); } catch { return null; }
  };
  const count = async (table: string) => {
    const [r] = await sq.query<{ n: number }>(`SELECT COUNT(*) n FROM \`${table}\` WHERE tenant_id=:t`, { replacements: { t: ctx.tenantId }, type: QueryTypes.SELECT });
    return Number(r?.n ?? 0);
  };
  const admin: Tile[] = [
    hasPermission(ctx, "user.read") && { label: "Users", value: await count("users") },
    hasPermission(ctx, "project.read") && { label: "Projects", value: await count("projects") },
    hasPermission(ctx, "org.read") && { label: "Branches", value: await count("branches") },
    hasPermission(ctx, "audit.read") && { label: "Audit events", value: await count("audit_events") },
  ].filter(Boolean) as Tile[];
  const [sales, mgr, prop, comp] = await Promise.all([dash("sales"), dash("manager"), dash("property"), dash("compliance")]);
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      {sales && (
        <Tiles title="Sales (your visible leads)" tiles={[
          { label: "Open leads", value: sales.leads.open }, { label: "Won", value: sales.leads.won }, { label: "Conversion", value: pct(sales.leads.conversionRate) },
          { label: "Median first response (min)", value: sales.medianFirstResponseMinutes ?? "-" }, { label: "Hot leads", value: sales.scoreBands.hot }, { label: "Warm leads", value: sales.scoreBands.warm },
          { label: "Open deals", value: sales.deals.open }, { label: "Open deal value (AED)", value: Math.round(sales.deals.openValue).toLocaleString("en-US") },
        ]} />
      )}
      {mgr && (
        <div className="card overflow-x-auto p-2">
          <h2 className="p-2 font-semibold">Team</h2>
          <table className="t">
            <thead><tr><th>Agent</th><th>Open</th><th>Won</th><th>Lost</th><th>Closed deals</th><th>Closed value (AED)</th></tr></thead>
            <tbody>{mgr.agents.map((a: any) => <tr key={a.agent}><td>{a.agent}</td><td>{a.open}</td><td>{a.won}</td><td>{a.lost}</td><td>{a.closedDeals}</td><td>{Math.round(a.closedValue).toLocaleString("en-US")}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {prop && (
        <Tiles title="Property management" tiles={[
          { label: "Units managed", value: prop.units.managed }, { label: "Occupancy", value: pct(prop.units.occupancyRate) }, { label: "Overdue instalments", value: prop.rentOverdue.instalments },
          { label: "Overdue rent (AED)", value: prop.rentOverdue.outstanding }, { label: "Leases expiring (90d)", value: prop.leasesExpiring90d }, { label: "Open tickets", value: prop.maintenance.open },
          { label: "Open tickets past SLA", value: prop.maintenance.slaBreachedOpen },
        ]} />
      )}
      {comp && (
        <Tiles title="Compliance" tiles={[
          { label: "Open cases", value: comp.cases.open + comp.cases.escalated }, { label: "Screening hits to review", value: comp.openScreeningHits }, { label: "KYC expiring (30d)", value: comp.kyc.expiringIn30d },
          { label: "Open data requests", value: comp.dsr.open }, { label: "Overdue data requests", value: comp.dsr.overdue },
        ]} />
      )}
      {admin.length > 0 && <Tiles title="Organisation" tiles={admin} />}
    </section>
  );
}
