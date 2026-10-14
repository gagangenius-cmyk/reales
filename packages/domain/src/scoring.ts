import { createHash, randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { LEAD_SCOPE } from "./leads";
import { plain, scopeWhere } from "./scope";
import { assertSweepAllowed, ConflictError, NotFoundError, Uow, withUow } from "./uow";

/**
 * Lead scoring. Two model kinds share one feature set:
 *   rules    - hand-set points per feature (the always-available baseline, version 1)
 *   logistic - weights learned from THIS tenant's won/lost leads
 * Protected or sensitive attributes (nationality, language, name, gender) are deliberately NOT features, so a model cannot learn them.
 * Models are immutable once created; a change is a new version. Every score stores the version, the features and ranked reason codes.
 */
export const FEATURES = [
  "has_phone", "has_email", "budget_set", "budget_level", "intent_buy", "has_area_preference", "has_bedrooms", "replied", "viewing_booked", "recent_activity", "fast_first_response",
] as const;
export type Feature = (typeof FEATURES)[number];
export type FeatureVector = Record<Feature, number>;

export const FEATURE_LABELS: Record<Feature, string> = {
  has_phone: "Phone number on file", has_email: "Email on file", budget_set: "Budget stated", budget_level: "Higher budget", intent_buy: "Purchase intent (buy/invest/off-plan)",
  has_area_preference: "Preferred areas given", has_bedrooms: "Bedroom requirement given", replied: "Customer has replied", viewing_booked: "Viewing booked", recent_activity: "Activity in the last 7 days",
  fast_first_response: "First response within one hour",
};

export interface RulesDefinition { kind: "rules"; base: number; weights: Record<Feature, number>; hot: number; warm: number }
export interface LogisticDefinition { kind: "logistic"; intercept: number; weights: Record<Feature, number>; hot: number; warm: number }
export type ModelDefinition = RulesDefinition | LogisticDefinition;

/** ILLUSTRATIVE starting weights. They encode common sales-qualification heuristics, not a validated predictor. */
export const DEFAULT_RULES: RulesDefinition = {
  kind: "rules", base: 15, hot: 70, warm: 40,
  weights: { has_phone: 8, has_email: 4, budget_set: 12, budget_level: 8, intent_buy: 10, has_area_preference: 5, has_bedrooms: 4, replied: 15, viewing_booked: 20, recent_activity: 8, fast_first_response: 5 },
};

const bandOf = (score: number, d: { hot: number; warm: number }) => (score >= d.hot ? "hot" : score >= d.warm ? "warm" : "cold") as "hot" | "warm" | "cold";
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export interface ScoreResult { score: number; band: "hot" | "warm" | "cold"; reasons: Array<{ code: Feature; label: string; points: number }> }

/** Pure: same definition + features always yield the same score and reasons. */
export function evaluateModel(def: ModelDefinition, f: FeatureVector): ScoreResult {
  const contrib = FEATURES.map((k) => ({ code: k, label: FEATURE_LABELS[k], raw: def.weights[k] * f[k] }));
  let score: number;
  let reasons: ScoreResult["reasons"];
  if (def.kind === "rules") {
    score = Math.max(0, Math.min(100, Math.round(def.base + contrib.reduce((a, c) => a + c.raw, 0))));
    reasons = contrib.filter((c) => c.raw !== 0).map((c) => ({ code: c.code, label: c.label, points: Math.round(c.raw) }));
  } else {
    const z = def.intercept + contrib.reduce((a, c) => a + c.raw, 0);
    score = Math.round(100 * sigmoid(z));
    reasons = contrib.filter((c) => Math.abs(c.raw) > 1e-9).map((c) => ({ code: c.code, label: c.label, points: Math.round(c.raw * 100) / 100 }));
  }
  reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points) || a.code.localeCompare(b.code));
  return { score, band: bandOf(score, def), reasons: reasons.slice(0, 5) };
}

// ---------------------------------------------------------------- features
const DAY = 86_400_000;
export async function leadFeatures(u: Uow, lead: any, now = new Date()): Promise<FeatureVector> {
  const contact: any = await u.repo("Contact").findById(lead.get("contactId"), { transaction: u.tx });
  const budget = Number(lead.get("budgetMax") ?? 0);
  const areas = lead.get("preferredAreas");
  const inbound = (await u.sq.query<any>(
    "SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id WHERE m.tenant_id=:t AND c.contact_id=:c AND m.direction='inbound'",
    { replacements: { t: u.tenantId, c: lead.get("contactId") }, transaction: u.tx, type: QueryTypes.SELECT },
  ))[0];
  const viewings = await u.repo("Viewing").count({ where: { leadId: lead.get("id"), status: { [Op.ne]: "cancelled" } }, transaction: u.tx });
  const recent = await u.repo("Activity").count({ where: { entityType: "lead", entityId: lead.get("id"), occurredAt: { [Op.gte]: new Date(now.getTime() - 7 * DAY) } }, transaction: u.tx });
  const first = lead.get("firstResponseAt");
  const fast = first && new Date(first).getTime() - new Date(lead.get("createdAt")).getTime() <= 3_600_000;
  return {
    has_phone: contact?.get("phoneE164") ? 1 : 0, has_email: contact?.get("email") ? 1 : 0, budget_set: budget > 0 ? 1 : 0,
    budget_level: budget > 0 ? Math.max(0, Math.min(1, (Math.log10(budget) - 5) / 3)) : 0, // 100k -> 0, 100M -> 1
    intent_buy: ["buy", "invest", "off_plan"].includes(lead.get("purpose")) ? 1 : 0, has_area_preference: Array.isArray(areas) && areas.length ? 1 : 0, has_bedrooms: lead.get("bedrooms") ? 1 : 0,
    replied: Number(inbound?.n ?? 0) > 0 ? 1 : 0, viewing_booked: viewings > 0 ? 1 : 0, recent_activity: recent > 0 ? 1 : 0, fast_first_response: fast ? 1 : 0,
  };
}

// ---------------------------------------------------------------- model lifecycle
async function maxVersion(u: Uow): Promise<number> {
  const r = await u.sq.query<any>("SELECT COALESCE(MAX(version), 0) v FROM scoring_models WHERE tenant_id=:t FOR UPDATE", { replacements: { t: u.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
  return Number(r[0]?.v ?? 0);
}

async function activeModel(u: Uow) {
  let m: any = await u.repo("ScoringModel").findOne({ where: { status: "active" }, transaction: u.tx });
  if (!m) {
    const id = randomUUID();
    const next = await maxVersion(u);
    await u.repo("ScoringModel").create({ id, version: next + 1, kind: "rules", status: "active", definition: DEFAULT_RULES, createdBy: "system", activatedAt: new Date() }, { transaction: u.tx });
    m = await u.repo("ScoringModel").findById(id, { transaction: u.tx });
  }
  return m;
}

export async function listScoringModels(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "scoring.read");
  return withUow(sq, ctx, async (u) => { await activeModel(u); return (await u.repo("ScoringModel").findAll({ order: [["version", "DESC"]], transaction: u.tx })).map(plain); });
}

const leadRef = (l: any) => ({ ownerUserId: l.get("assignedUserId"), branchId: l.get("branchId"), projectId: l.get("projectId") });

async function writeScore(u: Uow, model: any, lead: any, now = new Date()) {
  const features = await leadFeatures(u, lead, now);
  const r = evaluateModel(model.get("definition") as ModelDefinition, features);
  await u.repo("LeadScore").create({ id: randomUUID(), leadId: lead.get("id"), modelId: model.get("id"), modelVersion: model.get("version"), score: r.score, band: r.band, reasons: r.reasons, features, createdAt: mysqlDate(now) }, { transaction: u.tx });
  await u.repo("Lead").updateById(lead.get("id"), { score: r.score }, { transaction: u.tx });
  return r;
}

export async function scoreLead(sq: Sequelize, ctx: RequestContext, leadId: string) {
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "scoring.read", LEAD_SCOPE);
    const lead: any = await u.repo("Lead").findOne({ where: { [Op.and]: [{ id: leadId }, scope] }, transaction: u.tx });
    if (!lead) throw new NotFoundError("Lead");
    const model = await activeModel(u);
    const r = await writeScore(u, model, lead);
    return { leadId, modelVersion: model.get("version"), ...r };
  });
}

export async function getLeadScore(sq: Sequelize, ctx: RequestContext, leadId: string) {
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "scoring.read", LEAD_SCOPE);
    if (!(await u.repo("Lead").findOne({ where: { [Op.and]: [{ id: leadId }, scope] }, transaction: u.tx }))) throw new NotFoundError("Lead");
    const rows = await u.repo("LeadScore").findAll({ where: { leadId }, order: [["createdAt", "DESC"]], limit: 20, transaction: u.tx });
    return { latest: rows[0] ? plain(rows[0]) : null, history: rows.map(plain) };
  });
}

/** Re-scores open leads whose latest score is missing, older than `maxAgeHours`, or from an older model version. Bounded per run. */
export async function rescoreOpenLeads(sq: Sequelize, ctx: RequestContext, o: { maxAgeHours?: number; limit?: number; now?: Date } = {}) {
  assertSweepAllowed(ctx, "scoring.manage");
  const now = o.now ?? new Date();
  return withUow(sq, ctx, async (u) => {
    const model = await activeModel(u);
    const cutoff = new Date(now.getTime() - (o.maxAgeHours ?? 24) * 3_600_000);
    const leads = (await u.repo("Lead").findAll({ where: { status: "open" }, order: [["createdAt", "ASC"]], limit: 2000, transaction: u.tx })) as any[];
    let n = 0;
    for (const l of leads) {
      if (n >= (o.limit ?? 200)) break;
      const last: any = await u.repo("LeadScore").findOne({ where: { leadId: l.get("id") }, order: [["createdAt", "DESC"]], transaction: u.tx });
      if (last && last.get("modelVersion") === model.get("version") && new Date(last.get("createdAt")) >= cutoff) continue;
      await writeScore(u, model, l, now);
      n++;
    }
    return n;
  });
}

// ---------------------------------------------------------------- training (logistic regression, pure TypeScript)
export interface Sample { x: FeatureVector; y: 0 | 1 }

const hashFrac = (s: string) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;

export function auc(scores: number[], labels: number[]): number | null {
  const pos = labels.filter((l) => l === 1).length;
  const neg = labels.length - pos;
  if (!pos || !neg) return null;
  let wins = 0;
  for (let i = 0; i < scores.length; i++) for (let j = 0; j < scores.length; j++) if (labels[i] === 1 && labels[j] === 0) wins += scores[i]! > scores[j]! ? 1 : scores[i] === scores[j] ? 0.5 : 0;
  return wins / (pos * neg);
}

export function trainLogistic(train: Sample[], opts: { epochs?: number; lr?: number; l2?: number } = {}) {
  const epochs = opts.epochs ?? 600;
  const lr = opts.lr ?? 0.3;
  const l2 = opts.l2 ?? 0.01;
  const w = Object.fromEntries(FEATURES.map((k) => [k, 0])) as Record<Feature, number>;
  const rate = train.filter((s) => s.y === 1).length / train.length;
  let b = Math.log(Math.max(rate, 0.01) / Math.max(1 - rate, 0.01));
  for (let e = 0; e < epochs; e++) {
    const gw = Object.fromEntries(FEATURES.map((k) => [k, 0])) as Record<Feature, number>;
    let gb = 0;
    for (const s of train) {
      const err = sigmoid(b + FEATURES.reduce((a, k) => a + w[k] * s.x[k], 0)) - s.y;
      gb += err;
      for (const k of FEATURES) gw[k] += err * s.x[k];
    }
    b -= (lr * gb) / train.length;
    for (const k of FEATURES) w[k] -= lr * (gw[k] / train.length + l2 * w[k]);
  }
  return { intercept: b, weights: w };
}

export const MIN_TRAINING_SAMPLES = 30;

/**
 * Trains a NEW draft version from this tenant's closed leads (won = 1, lost = 0). A deterministic 80/20 split gives held-out metrics.
 * Caveat stored with the model: some features (viewings, replies) can occur after the outcome signal starts forming, so the model
 * measures association, not causation. It stays a draft until a human activates it.
 */
export async function trainScoringModel(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "scoring.manage");
  const data = await withUow(sq, ctx, async (u) => {
    const leads = (await u.repo("Lead").findAll({ where: { status: { [Op.in]: ["won", "lost"] } }, limit: 5000, transaction: u.tx })) as any[];
    const out: Array<Sample & { id: string }> = [];
    for (const l of leads) out.push({ id: l.get("id"), x: await leadFeatures(u, l), y: l.get("status") === "won" ? 1 : 0 });
    return out;
  });
  const positives = data.filter((s) => s.y === 1).length;
  if (data.length < MIN_TRAINING_SAMPLES) throw new ConflictError(`At least ${MIN_TRAINING_SAMPLES} closed leads are needed to train (found ${data.length})`);
  if (positives === 0 || positives === data.length) throw new ConflictError("Training needs both won and lost leads");
  const train = data.filter((s) => hashFrac(s.id) < 0.8);
  const test = data.filter((s) => hashFrac(s.id) >= 0.8);
  const fit = trainLogistic(train);
  const def: LogisticDefinition = { kind: "logistic", intercept: fit.intercept, weights: fit.weights, hot: 70, warm: 40 };
  const probs = test.map((s) => evaluateModel(def, s.x).score);
  const acc = test.length ? test.filter((s, i) => (probs[i]! >= 50 ? 1 : 0) === s.y).length / test.length : null;
  const metrics = {
    samples: data.length, trainSamples: train.length, testSamples: test.length, wonRate: Number((positives / data.length).toFixed(3)),
    heldOutAuc: test.length ? auc(probs, test.map((s) => s.y)) : null, heldOutAccuracy: acc,
    baselineAccuracy: test.length ? Math.max(test.filter((s) => s.y === 1).length, test.filter((s) => s.y === 0).length) / test.length : null,
    caveat: "Learned from this tenant's own closed leads; features may partly reflect post-outcome activity. Association, not causation.",
  };
  return withUow(sq, ctx, async (u) => {
    await activeModel(u); // make sure the baseline exists first so version numbers stay consistent
    const next = (await maxVersion(u)) + 1;
    const id = randomUUID();
    await u.repo("ScoringModel").create({ id, version: next, kind: "logistic", status: "draft", definition: def, metrics, trainedOn: data.length, createdBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: "scoring.model_trained", entityType: "scoring_model", entityId: id, after: { version: next, samples: data.length, auc: metrics.heldOutAuc } });
    return plain(await u.repo("ScoringModel").findById(id, { transaction: u.tx }));
  });
}

/** Activation is explicit and audited. A model that does not clearly beat chance needs an acknowledgement. */
export async function activateScoringModel(sq: Sequelize, ctx: RequestContext, id: string, o: { acknowledgeWeak?: boolean } = {}) {
  authorize(ctx, "scoring.manage");
  return withUow(sq, ctx, async (u) => {
    await activeModel(u);
    const m: any = await u.repo("ScoringModel").findById(id, { transaction: u.tx });
    if (!m) throw new NotFoundError("Model");
    if (m.get("status") !== "draft") throw new ConflictError(`A ${m.get("status")} model cannot be activated`);
    const a = (m.get("metrics") as any)?.heldOutAuc;
    if (m.get("kind") === "logistic" && (a === null || a === undefined || a < 0.6) && !o.acknowledgeWeak) throw new ConflictError(`Held-out AUC is ${a === null || a === undefined ? "unavailable" : Number(a).toFixed(2)} (below 0.60); acknowledge to activate anyway`);
    await u.sq.query("UPDATE scoring_models SET status='retired' WHERE tenant_id=:t AND status='active'", { replacements: { t: ctx.tenantId }, transaction: u.tx });
    await u.repo("ScoringModel").updateById(id, { status: "active", activatedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "scoring.model_activated", entityType: "scoring_model", entityId: id, after: { version: m.get("version"), weak: !!o.acknowledgeWeak } });
    return plain(await u.repo("ScoringModel").findById(id, { transaction: u.tx }));
  });
}
