import { createHmac } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { requireStepUp } from "@reales/auth";
import { authorize, ForbiddenError, hasPermission, widestScope } from "@reales/rbac";
import { LEAD_SCOPE } from "./leads";
import { DEAL_SCOPE } from "./deals";
import { scopeWhere } from "./scope";
import { ConflictError, Uow, withUow } from "./uow";

export type DashboardKind = "sales" | "manager" | "property" | "compliance";

const rows = async (u: Uow, sql: string, r: Record<string, unknown> = {}): Promise<any[]> =>
  (await u.sq.query(sql, { replacements: { t: u.tenantId, ...r }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
const n = (v: unknown) => Number(v ?? 0);

/** Scoped dashboards: sales and manager views are built from the SAME scoped queries as the lists, so a user never sees numbers they could not drill into. */
async function sales(u: Uow, ctx: RequestContext) {
  const leadScope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
  const leads = (await u.repo("Lead").findAll({ where: leadScope, limit: 10_000, transaction: u.tx })) as any[];
  const open = leads.filter((l) => l.get("status") === "open");
  const won = leads.filter((l) => l.get("status") === "won").length;
  const lost = leads.filter((l) => l.get("status") === "lost").length;
  const stages = new Map<string, string>(((await u.repo("PipelineStage").findAll({ transaction: u.tx })) as any[]).map((s) => [s.get("id"), s.get("name")]));
  const sources = new Map<string, string>(((await u.repo("LeadSource").findAll({ transaction: u.tx })) as any[]).map((s) => [s.get("id"), s.get("name")]));
  const tally = (key: (l: any) => string) => {
    const m = new Map<string, number>();
    for (const l of leads) m.set(key(l), (m.get(key(l)) ?? 0) + 1);
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  };
  const resp = leads.filter((l) => l.get("firstResponseAt")).map((l) => (new Date(l.get("firstResponseAt")).getTime() - new Date(l.get("createdAt")).getTime()) / 60_000).filter((x) => x >= 0);
  const dealScope = await scopeWhere(u, ctx, "deal.read", DEAL_SCOPE).catch(() => null);
  const deals = dealScope ? ((await u.repo("Deal").findAll({ where: dealScope, limit: 10_000, transaction: u.tx })) as any[]) : [];
  return {
    leads: { total: leads.length, open: open.length, won, lost, conversionRate: won + lost ? Number((won / (won + lost)).toFixed(3)) : null },
    funnel: tally((l) => stages.get(l.get("stageId")) ?? "Unknown").filter((x) => open.some((l) => (stages.get(l.get("stageId")) ?? "Unknown") === x.name)),
    bySource: tally((l) => (l.get("sourceId") ? sources.get(l.get("sourceId")) ?? "Unknown" : "Unattributed")),
    scoreBands: { hot: open.filter((l) => n(l.get("score")) >= 70).length, warm: open.filter((l) => n(l.get("score")) >= 40 && n(l.get("score")) < 70).length, cold: open.filter((l) => l.get("score") !== null && n(l.get("score")) < 40).length, unscored: open.filter((l) => l.get("score") === null).length },
    medianFirstResponseMinutes: resp.length ? Math.round(resp.sort((a, b) => a - b)[Math.floor(resp.length / 2)]!) : null,
    deals: { open: deals.filter((d) => d.get("status") === "open").length, closed: deals.filter((d) => d.get("status") === "closed").length, openValue: deals.filter((d) => d.get("status") === "open").reduce((a, d) => a + n(d.get("amount")), 0) },
  };
}

async function manager(u: Uow, ctx: RequestContext) {
  const leadScope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
  const leads = (await u.repo("Lead").findAll({ where: leadScope, limit: 10_000, transaction: u.tx })) as any[];
  const dealScope = await scopeWhere(u, ctx, "deal.read", DEAL_SCOPE);
  const deals = (await u.repo("Deal").findAll({ where: dealScope, limit: 10_000, transaction: u.tx })) as any[];
  const agents = new Map<string, { agentId: string | null; open: number; won: number; lost: number; closedDeals: number; closedValue: number }>();
  const row = (id: string | null) => { const k = id ?? "unassigned"; if (!agents.has(k)) agents.set(k, { agentId: id, open: 0, won: 0, lost: 0, closedDeals: 0, closedValue: 0 }); return agents.get(k)!; };
  for (const l of leads) row(l.get("assignedUserId") ?? null)[l.get("status") as "open" | "won" | "lost"]++;
  for (const d of deals.filter((x) => x.get("status") === "closed")) { const r = row(d.get("agentUserId")); r.closedDeals++; r.closedValue += n(d.get("amount")); }
  const names = new Map<string, string>(((await u.repo("User").findAll({ transaction: u.tx })) as any[]).map((x) => [x.get("id"), x.get("email")]));
  return { agents: [...agents.values()].map((a) => ({ ...a, agent: a.agentId ? names.get(a.agentId) ?? a.agentId : "Unassigned" })).sort((a, b) => b.closedValue - a.closedValue || b.won - a.won) };
}

async function property(u: Uow, ctx: RequestContext) {
  if (widestScope(ctx, "lease.read") !== "tenant") throw new ConflictError("The property dashboard needs tenant-wide lease access");
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const [owned] = await rows(u, "SELECT COUNT(DISTINCT unit_id) c FROM ownerships WHERE tenant_id=:t AND to_date IS NULL");
  const [occupied] = await rows(u, "SELECT COUNT(DISTINCT unit_id) c FROM leases WHERE tenant_id=:t AND status='active' AND starts_on <= :d AND COALESCE(terminated_on, ends_on) >= :d", { d: today });
  const [overdue] = await rows(u, "SELECT COUNT(*) c, COALESCE(SUM(amount - paid_amount),0) s FROM rent_schedules WHERE tenant_id=:t AND status='overdue'");
  const [expiring] = await rows(u, "SELECT COUNT(*) c FROM leases WHERE tenant_id=:t AND status='active' AND ends_on BETWEEN :d AND :h", { d: today, h: horizon });
  const tickets = await rows(u, "SELECT status, COUNT(*) c, SUM(CASE WHEN sla_breached_at IS NOT NULL THEN 1 ELSE 0 END) breached FROM maintenance_tickets WHERE tenant_id=:t GROUP BY status");
  const open = tickets.filter((x) => !["completed", "closed", "cancelled"].includes(x.status));
  return {
    units: { managed: n(owned.c), occupied: n(occupied.c), occupancyRate: n(owned.c) ? Number((n(occupied.c) / n(owned.c)).toFixed(3)) : null },
    rentOverdue: { instalments: n(overdue.c), outstanding: n(overdue.s).toFixed(2) }, leasesExpiring90d: n(expiring.c),
    maintenance: { open: open.reduce((a, x) => a + n(x.c), 0), slaBreachedOpen: open.reduce((a, x) => a + n(x.breached), 0) },
  };
}

async function compliance(u: Uow, ctx: RequestContext) {
  if (widestScope(ctx, "kyc.read") !== "tenant") throw new ConflictError("The compliance dashboard needs tenant-wide KYC access");
  const kyc = await rows(u, "SELECT status, risk_level, COUNT(*) c FROM kyc_profiles WHERE tenant_id=:t GROUP BY status, risk_level");
  const [cases] = await rows(u, "SELECT SUM(status='open') o, SUM(status='escalated') e FROM compliance_cases WHERE tenant_id=:t");
  const [hits] = await rows(u, "SELECT COUNT(*) c FROM screening_hits WHERE tenant_id=:t AND status='open'");
  const [dsr] = await rows(u, "SELECT COUNT(*) c, SUM(due_at < NOW(3)) late FROM dsr_requests WHERE tenant_id=:t AND status='received'");
  const [soon] = await rows(u, "SELECT COUNT(*) c FROM kyc_profiles WHERE tenant_id=:t AND status='approved' AND expires_at <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)");
  const by = (k: "status" | "risk_level") => Object.entries(kyc.reduce((a: Record<string, number>, r) => ({ ...a, [r[k]]: (a[r[k]] ?? 0) + n(r.c) }), {})).map(([name, count]) => ({ name, count }));
  return { kyc: { byStatus: by("status"), byRisk: by("risk_level"), expiringIn30d: n(soon.c) }, cases: { open: n(cases?.o), escalated: n(cases?.e) }, openScreeningHits: n(hits.c), dsr: { open: n(dsr.c), overdue: n(dsr.late) } };
}

const NEEDS: Record<DashboardKind, string> = { sales: "lead.read", manager: "lead.read", property: "lease.read", compliance: "kyc.read" };

export async function getDashboard(sq: Sequelize, ctx: RequestContext, kind: DashboardKind) {
  // Row-scoped (own_records/branch) grants cannot be checked without a resource; the data queries below apply the scope themselves.
  for (const p of ["analytics.read", NEEDS[kind]]) if (!hasPermission(ctx, p)) throw new ForbiddenError(`Missing permission: ${p}`);
  return withUow(sq, ctx, async (u) => {
    const data = kind === "sales" ? await sales(u, ctx) : kind === "manager" ? await manager(u, ctx) : kind === "property" ? await property(u, ctx) : await compliance(u, ctx);
    return { kind, generatedAt: new Date().toISOString(), ...data };
  });
}

// ---------------------------------------------------------------- warehouse export
export const EXPORT_ENTITIES = ["leads", "deals", "invoices", "leases", "tickets", "lead_scores"] as const;
export type ExportEntity = (typeof EXPORT_ENTITIES)[number];

const SQL: Record<ExportEntity, { sql: string; cursor: string; pseudo: string[] }> = {
  leads: { sql: "SELECT id, contact_id, project_id, source_id, stage_id, status, purpose, budget_min, budget_max, currency, bedrooms, assigned_user_id, branch_id, score, first_response_at, created_at, updated_at FROM leads", cursor: "updated_at", pseudo: ["contact_id"] },
  deals: { sql: "SELECT id, deal_type, unit_id, contact_id, agent_user_id, branch_id, project_id, stage, status, amount, currency, created_at, updated_at FROM deals", cursor: "updated_at", pseudo: ["contact_id"] },
  invoices: { sql: "SELECT id, number, deal_id, contact_id, status, subtotal, vat_amount, total, currency, due_date, created_at, updated_at FROM invoices", cursor: "updated_at", pseudo: ["contact_id"] },
  leases: { sql: "SELECT id, unit_id, portfolio_id, status, starts_on, ends_on, annual_rent, currency, installments, jurisdiction_code, created_at, updated_at FROM leases", cursor: "updated_at", pseudo: [] },
  tickets: { sql: "SELECT id, unit_id, portfolio_id, category, priority, status, sla_due_at, sla_breached_at, resolved_at, created_at, updated_at FROM maintenance_tickets", cursor: "updated_at", pseudo: [] },
  lead_scores: { sql: "SELECT id, lead_id, model_version, score, band, created_at FROM lead_scores", cursor: "created_at", pseudo: [] },
};

/**
 * Incremental, PII-minimised export for a warehouse/BI tool. Names, e-mails and phone numbers are never included, and person ids are replaced by a
 * keyed pseudonym (HMAC with a per-tenant derived key) so records can be joined in the warehouse without exposing the CRM identifier. Cursor = (timestamp, id).
 */
export async function exportForWarehouse(sq: Sequelize, ctx: RequestContext, i: { entity: ExportEntity; after?: string; limit?: number }) {
  authorize(ctx, "analytics.export");
  requireStepUp(ctx);
  const spec = SQL[i.entity];
  if (!spec) throw new ConflictError("Unknown entity");
  const limit = Math.min(Math.max(i.limit ?? 1000, 1), 5000);
  const [afterTs, afterId] = (i.after ?? "").split("|");
  if (!process.env.FIELD_ENCRYPTION_KEY) throw new ConflictError("FIELD_ENCRYPTION_KEY is required to pseudonymise exports");
  const key = createHmac("sha256", process.env.FIELD_ENCRYPTION_KEY ?? "").update(`warehouse:${ctx.tenantId}`).digest();
  return withUow(sq, ctx, async (u) => {
    const where = afterTs ? `AND (${spec.cursor} > :ts OR (${spec.cursor} = :ts AND id > :id))` : "";
    const data = await rows(u, `${spec.sql} WHERE tenant_id=:t ${where} ORDER BY ${spec.cursor}, id LIMIT ${limit}`, { ts: afterTs ? mysqlDate(new Date(afterTs)) : null, id: afterId ?? "" });
    const out = data.map((r) => {
      const o: Record<string, unknown> = { ...r };
      for (const p of spec.pseudo) if (o[p]) o[p] = createHmac("sha256", key).update(String(o[p])).digest("hex").slice(0, 32);
      return o;
    });
    const last = data[data.length - 1];
    await u.audit({ action: "analytics.exported", entityType: "tenant", entityId: ctx.tenantId, after: { entity: i.entity, rows: out.length } });
    return { entity: i.entity, rows: out, nextCursor: last ? `${new Date(last[spec.cursor]).toISOString()}|${last.id}` : i.after ?? null, hasMore: data.length === limit };
  });
}

void Op;
