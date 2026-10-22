import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { fromMinor, toMinor } from "./money";
import { plain } from "./scope";
import { NotFoundError, withUow } from "./uow";

export interface Comp { kind: "sold" | "asking"; ref: string; unitNumber: string; bedrooms: number | null; areaSqft: number; price: number; pricePerSqft: number; date: string }
export interface ValuationResult { sufficient: boolean; estimate?: number; low?: number; high?: number; pricePerSqft?: number; confidence?: "low" | "medium" | "high"; comps: Comp[]; method: string; note: string }

const ASKING_HAIRCUT = 0.95; // asking prices run above what actually transacts; they are discounted and always labelled
const MIN_COMPS = 3;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Pure: comparable-sales estimate. Refuses to guess with fewer than three comparables. */
export function estimateFromComps(areaSqft: number, comps: Comp[]): ValuationResult {
  const method = "Median price per sq ft of comparable closed deals (and 5%-discounted asking prices) in the same community, type and bedroom range";
  if (comps.length < MIN_COMPS) return { sufficient: false, comps, method, note: `Only ${comps.length} comparable(s) found; at least ${MIN_COMPS} are needed for an estimate.` };
  const psf = comps.map((c) => (c.kind === "asking" ? c.pricePerSqft * ASKING_HAIRCUT : c.pricePerSqft)).sort((a, b) => a - b);
  const sold = comps.filter((c) => c.kind === "sold").length;
  const mid = quantile(psf, 0.5);
  const confidence = sold >= 8 ? "high" : sold >= 4 || comps.length >= 8 ? "medium" : "low";
  return {
    sufficient: true, pricePerSqft: Math.round(mid), estimate: Math.round(mid * areaSqft), low: Math.round(quantile(psf, 0.25) * areaSqft), high: Math.round(quantile(psf, 0.75) * areaSqft),
    confidence, comps, method, note: `Based on ${sold} closed deal(s) and ${comps.length - sold} asking price(s). An indication, not a formal valuation.`,
  };
}

export async function valuateUnit(sq: Sequelize, ctx: RequestContext, unitId: string, o: { save?: boolean } = {}) {
  authorize(ctx, "valuation.run");
  return withUow(sq, ctx, async (u) => {
    const rows = await u.sq.query<any>(
      `SELECT un.id, un.bedrooms, un.type, un.area_sqft, un.unit_number, b.community FROM units un JOIN buildings b ON b.id = un.building_id AND b.tenant_id = un.tenant_id WHERE un.id=:id AND un.tenant_id=:t`,
      { replacements: { id: unitId, t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT },
    );
    const unit = rows[0];
    if (!unit) throw new NotFoundError("Unit");
    const area = Number(unit.area_sqft ?? 0);
    if (!(area > 0)) return { unitId, ...estimateFromComps(0, []), note: "The unit has no area recorded, so a price per sq ft cannot be applied." };
    const bed = unit.bedrooms ?? -99;
    const common = { t: ctx.tenantId, id: unitId, community: unit.community, type: unit.type, lo: bed - 1, hi: bed + 1 };
    const sold = await u.sq.query<any>(
      `SELECT d.id, d.amount, d.updated_at, un.unit_number, un.bedrooms, un.area_sqft FROM deals d JOIN units un ON un.id = d.unit_id AND un.tenant_id = d.tenant_id JOIN buildings b ON b.id = un.building_id AND b.tenant_id = un.tenant_id
        WHERE d.tenant_id=:t AND d.status='closed' AND d.deal_type='sale' AND d.updated_at >= DATE_SUB(NOW(), INTERVAL 365 DAY) AND un.id<>:id AND b.community=:community AND un.type=:type
          AND un.bedrooms BETWEEN :lo AND :hi AND un.area_sqft > 0 ORDER BY d.updated_at DESC LIMIT 40`,
      { replacements: common, transaction: u.tx, type: QueryTypes.SELECT },
    );
    const asking = await u.sq.query<any>(
      `SELECT l.id, l.price, l.published_at, un.unit_number, un.bedrooms, un.area_sqft FROM listings l JOIN units un ON un.id = l.unit_id AND un.tenant_id = l.tenant_id JOIN buildings b ON b.id = un.building_id AND b.tenant_id = un.tenant_id
        WHERE l.tenant_id=:t AND l.deleted_at IS NULL AND un.deleted_at IS NULL AND l.status='published' AND l.purpose='sale' AND l.price > 0 AND un.id<>:id AND b.community=:community AND un.type=:type AND un.bedrooms BETWEEN :lo AND :hi AND un.area_sqft > 0 LIMIT 40`,
      { replacements: common, transaction: u.tx, type: QueryTypes.SELECT },
    );
    const comps: Comp[] = [
      ...sold.map((r) => ({ kind: "sold" as const, ref: r.id, unitNumber: r.unit_number, bedrooms: r.bedrooms, areaSqft: Number(r.area_sqft), price: Number(r.amount), pricePerSqft: Number(r.amount) / Number(r.area_sqft), date: new Date(r.updated_at).toISOString().slice(0, 10) })),
      ...asking.map((r) => ({ kind: "asking" as const, ref: r.id, unitNumber: r.unit_number, bedrooms: r.bedrooms, areaSqft: Number(r.area_sqft), price: Number(r.price), pricePerSqft: Number(r.price) / Number(r.area_sqft), date: r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : "" })),
    ];
    const r = estimateFromComps(area, comps);
    let id: string | null = null;
    if (r.sufficient && (o.save ?? true)) {
      id = randomUUID();
      await u.repo("Valuation").create({ id, unitId, estimate: fromMinor(toMinor(r.estimate)), low: fromMinor(toMinor(r.low)), high: fromMinor(toMinor(r.high)), pricePerSqft: fromMinor(toMinor(r.pricePerSqft)), confidence: r.confidence, comps: r.comps, method: r.method.slice(0, 80), createdBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
      await u.audit({ action: "valuation.run", entityType: "unit", entityId: unitId, after: { estimate: r.estimate, confidence: r.confidence } });
    }
    return { unitId, valuationId: id, ...r };
  });
}

export async function listValuations(sq: Sequelize, ctx: RequestContext, unitId: string) {
  authorize(ctx, "valuation.read");
  return withUow(sq, ctx, async (u) => (await u.repo("Valuation").findAll({ where: { unitId }, order: [["createdAt", "DESC"]], limit: 20, transaction: u.tx })).map(plain));
}
