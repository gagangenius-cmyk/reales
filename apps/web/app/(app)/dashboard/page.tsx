import { getSequelize } from "@reales/database";
import { getDashboard, type DashboardKind } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import Link from "next/link";
import { QueryTypes } from "sequelize";
import { requireContext } from "@/lib/page-context";

export const metadata = { title: "Dashboard | Reales CRM" };

type Tile = { label: string; value: string | number };

function Tiles({ title, tiles }: { title: string; tiles: Tile[] }) {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="card stat relative overflow-hidden">
            <span className="absolute inset-y-0 left-0 w-1" style={{ background: "linear-gradient(180deg, var(--accent), var(--accent-2))" }} />
            <p className="muted text-xs font-medium uppercase tracking-wide">{t.label}</p><b>{t.value}</b>
          </div>
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
  // Follow-ups the signed-in person owns that are due, oldest first. Own leads only, whatever the role.
  const due = hasPermission(ctx, "lead.read")
    ? await sq.query<{ id: string; purpose: string; is_hot: number; next_follow_up_at: Date }>(
        "SELECT id, purpose, is_hot, next_follow_up_at FROM leads WHERE tenant_id=:t AND deleted_at IS NULL AND assigned_user_id=:u AND status='open' AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= NOW() ORDER BY next_follow_up_at ASC LIMIT 6",
        { replacements: { t: ctx.tenantId, u: ctx.userId }, type: QueryTypes.SELECT }).catch(() => [])
    : [];
  const hour = (new Date().getUTCHours() + 4) % 24;
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <section className="flex flex-col gap-6">
      <div className="page-head"><div><h1>{greeting}</h1><p className="muted text-sm">Here is where things stand across what you can see.</p></div></div>
      {due.length > 0 && (
        <div className="card p-4" style={{ borderColor: "var(--warn)" }}>
          <h2 className="mb-2 font-semibold">Follow-ups due ({due.length})</h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {due.map((d) => <li key={d.id} className="flex items-center justify-between gap-3"><span>{d.is_hot ? <span className="err">&#9650; </span> : null}{d.purpose} lead &middot; due {new Date(d.next_follow_up_at).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" })}</span><Link className="btn-ghost text-xs" href={`/leads/${d.id}`}>Open</Link></li>)}
          </ul>
        </div>
      )}
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
