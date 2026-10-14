import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { decryptField, encryptField, requireStepUp } from "@reales/auth";
import { authorize, hasPermission } from "@reales/rbac";
import { CONTACT_SCOPE } from "./contacts";
import { registerDealGate } from "./deals";
import { plain, scopeWhere } from "./scope";
import { assertSweepAllowed, ConflictError, NotFoundError, Uow, withUow } from "./uow";

const today = () => new Date().toISOString().slice(0, 10);
const addDaysIso = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

/** Tenant setting lookup (JSON value). Compliance thresholds are configuration, not code. */
export async function tenantSetting<T>(u: Uow, key: string, fallback: T): Promise<T> {
  const s: any = await u.repo("TenantSetting").findOne({ where: { key }, transaction: u.tx });
  const v = s?.get("value");
  return v === null || v === undefined ? fallback : (v as T);
}

/** The contact must be visible to the caller under the given permission's scope (tenant-wide for compliance staff). */
async function visibleContact(u: Uow, ctx: RequestContext, permission: string, contactId: string) {
  const scope = await scopeWhere(u, ctx, permission, CONTACT_SCOPE);
  const c: any = await u.repo("Contact").findOne({ where: { [Op.and]: [{ id: contactId }, scope] }, transaction: u.tx });
  if (!c) throw new NotFoundError("Contact");
  return c;
}

async function caseEvent(u: Uow, ctx: RequestContext | { userId: string }, caseId: string, type: string, detail: unknown) {
  await u.repo("CaseEvent").create({ id: randomUUID(), caseId, type, detail: detail ?? {}, actorId: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
}

// ---------------------------------------------------------------- risk scoring (deterministic, explainable)
export interface RiskInput {
  isPep: boolean; countries: string[]; highRiskCountries: string[]; hasSourceOfFunds: boolean; isEntity: boolean; uboIdentified: boolean; openHits: number; trueMatches: number;
}
export interface RiskResult { score: number; level: "low" | "medium" | "high"; factors: Array<{ code: string; points: number; note: string }> }

/** Every point is traceable to a named factor. Weights are ILLUSTRATIVE defaults and need review by the compliance function. */
export function computeRisk(i: RiskInput): RiskResult {
  const factors: RiskResult["factors"] = [];
  const add = (code: string, points: number, note: string) => factors.push({ code, points, note });
  if (i.isPep) add("pep", 40, "Politically exposed person");
  const hr = i.countries.filter((c) => c && i.highRiskCountries.map((x) => x.toLowerCase()).includes(c.toLowerCase()));
  if (hr.length) add("high_risk_country", 30, `Linked to configured high-risk jurisdiction: ${[...new Set(hr)].join(", ")}`);
  if (!i.hasSourceOfFunds) add("no_source_of_funds", 10, "Source of funds not recorded");
  if (i.isEntity && !i.uboIdentified) add("ubo_unidentified", 25, "No beneficial owner identified for the entity");
  if (i.openHits > 0) add("open_screening_hits", 20, `${i.openHits} screening hit(s) awaiting disposition`);
  if (i.trueMatches > 0) add("confirmed_match", 50, `${i.trueMatches} confirmed screening match(es)`);
  const score = Math.min(100, factors.reduce((a, f) => a + f.points, 0));
  return { score, level: score >= 60 ? "high" : score >= 30 ? "medium" : "low", factors };
}

// ---------------------------------------------------------------- KYC profiles
export interface KycInput {
  idType?: string; idNumber?: string; dateOfBirth?: string; nationality?: string; countryOfResidence?: string; sourceOfFunds?: string; occupation?: string;
}

/** Never return the encrypted blobs: callers get the last four characters of the identity number only. */
function publicProfile(p: any) {
  const o = { ...(plain(p) as any) };
  delete o.idNumberEnc;
  delete o.dateOfBirthEnc;
  o.hasIdNumber = !!p.get("idNumberEnc");
  o.hasDateOfBirth = !!p.get("dateOfBirthEnc");
  return o;
}

export async function upsertKycProfile(sq: Sequelize, ctx: RequestContext, contactId: string, i: KycInput) {
  authorize(ctx, "kyc.manage");
  return withUow(sq, ctx, async (u) => {
    const contact = await visibleContact(u, ctx, "kyc.manage", contactId);
    const existing: any = await u.repo("KycProfile").findOne({ where: { contactId }, transaction: u.tx });
    const patch: Record<string, unknown> = {};
    if (i.idType !== undefined) patch.idType = i.idType;
    if (i.idNumber !== undefined) { patch.idNumberEnc = i.idNumber ? encryptField(i.idNumber) : null; patch.idNumberLast4 = i.idNumber ? i.idNumber.slice(-4) : null; }
    if (i.dateOfBirth !== undefined) patch.dateOfBirthEnc = i.dateOfBirth ? encryptField(i.dateOfBirth) : null;
    for (const k of ["nationality", "countryOfResidence", "sourceOfFunds", "occupation"] as const) if (i[k] !== undefined) patch[k] = i[k];
    let id: string;
    if (!existing) {
      id = randomUUID();
      await u.repo("KycProfile").create({ id, contactId, subjectType: contact.get("type") === "company" ? "entity" : "individual", status: "draft", riskLevel: "unrated", isPep: false, nationality: contact.get("nationality") ?? null, ...patch }, { transaction: u.tx });
    } else {
      id = existing.get("id");
      // A material change to an approved or in-review profile invalidates the earlier decision: it must be re-reviewed.
      const reset = ["approved", "in_review", "rejected", "expired"].includes(existing.get("status")) ? { status: "draft", riskLevel: "unrated", riskScore: null, expiresAt: null, reviewedBy: null, reviewedAt: null } : {};
      await u.repo("KycProfile").updateById(id, { ...patch, ...reset }, { transaction: u.tx });
    }
    await u.audit({ action: "kyc.profile_saved", entityType: "contact", entityId: contactId, after: { fields: Object.keys(patch), resetDecision: !!existing && existing.get("status") !== "draft" } });
    return publicProfile(await u.repo("KycProfile").findById(id, { transaction: u.tx }));
  });
}

async function profileFor(u: Uow, ctx: RequestContext, id: string, permission = "kyc.read") {
  const p: any = await u.repo("KycProfile").findById(id, { transaction: u.tx });
  if (!p) throw new NotFoundError("KYC profile");
  await visibleContact(u, ctx, permission, p.get("contactId"));
  return p;
}

async function viewProfile(u: Uow, ctx: RequestContext, id: string) {
  const p = await profileFor(u, ctx, id);
  const [docs, hits, cases, ubo] = await Promise.all([
    u.repo("KycDocument").findAll({ where: { profileId: id }, transaction: u.tx }),
    u.repo("ScreeningHit").findAll({ where: { profileId: id }, order: [["createdAt", "DESC"]], transaction: u.tx }),
    u.repo("ComplianceCase").findAll({ where: { profileId: id }, order: [["createdAt", "DESC"]], transaction: u.tx }),
    u.repo("UboLink").findAll({ where: { parentContactId: p.get("contactId") }, transaction: u.tx }),
  ]);
  return { ...publicProfile(p), documents: docs.map(plain), hits: hits.map(plain), cases: cases.map(plain), uboLinks: ubo.map(plain) };
}

export async function getKycProfileByContact(sq: Sequelize, ctx: RequestContext, contactId: string) {
  authorize(ctx, "kyc.read");
  return withUow(sq, ctx, async (u) => {
    await visibleContact(u, ctx, "kyc.read", contactId);
    const p: any = await u.repo("KycProfile").findOne({ where: { contactId }, transaction: u.tx });
    return p ? viewProfile(u, ctx, p.get("id")) : null;
  });
}

export async function listKycProfiles(sq: Sequelize, ctx: RequestContext, f: { status?: string; riskLevel?: string; limit: number; offset: number }) {
  authorize(ctx, "kyc.read");
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "kyc.read", CONTACT_SCOPE);
    const visible = (await u.repo("Contact").findAll({ where: scope, attributes: ["id"], transaction: u.tx })) as any[];
    const where: any = { contactId: { [Op.in]: visible.map((c) => c.get("id")) }, ...(f.status ? { status: f.status } : {}), ...(f.riskLevel ? { riskLevel: f.riskLevel } : {}) };
    return (await u.repo("KycProfile").findAll({ where, order: [["updatedAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(publicProfile);
  });
}

export async function addKycDocument(sq: Sequelize, ctx: RequestContext, profileId: string, i: { documentId: string; docType: string; expiresOn?: string }) {
  authorize(ctx, "kyc.manage");
  return withUow(sq, ctx, async (u) => {
    await profileFor(u, ctx, profileId, "kyc.manage");
    if (!(await u.repo("Document").findById(i.documentId, { transaction: u.tx }))) throw new NotFoundError("Document");
    if (i.expiresOn && i.expiresOn < today()) throw new ConflictError("This identity document has already expired");
    const d = await u.repo("KycDocument").create({ id: randomUUID(), profileId, documentId: i.documentId, docType: i.docType, expiresOn: i.expiresOn ?? null }, { transaction: u.tx });
    await u.audit({ action: "kyc.document_added", entityType: "kyc_profile", entityId: profileId, after: { docType: i.docType } });
    return plain(d);
  });
}

// ---------------------------------------------------------------- beneficial ownership
const UBO_THRESHOLD_PCT = 25; // ILLUSTRATIVE: confirm the threshold with the compliance function

async function ownersOf(u: Uow, contactId: string) {
  return (await u.repo("UboLink").findAll({ where: { parentContactId: contactId }, transaction: u.tx })) as any[];
}

export async function linkUbo(sq: Sequelize, ctx: RequestContext, i: { parentContactId: string; ownerContactId: string; ownershipPct: number; relation?: "shareholder" | "director" | "controller" | "trustee" }) {
  authorize(ctx, "kyc.manage");
  const relation = i.relation ?? "shareholder";
  if (i.parentContactId === i.ownerContactId) throw new ConflictError("A contact cannot own itself");
  if (!(i.ownershipPct > 0 && i.ownershipPct <= 100)) throw new ConflictError("Ownership must be between 0 and 100 percent");
  return withUow(sq, ctx, async (u) => {
    const parent = await visibleContact(u, ctx, "kyc.manage", i.parentContactId);
    await visibleContact(u, ctx, "kyc.manage", i.ownerContactId);
    if (parent.get("type") !== "company") throw new ConflictError("Ownership links attach to a company contact");
    await u.sq.query("SELECT id FROM contacts WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: i.parentContactId, t: ctx.tenantId }, transaction: u.tx });
    // Cycle check: following the owner's own owners must never lead back to the parent.
    const seen = new Set<string>();
    const stack = [i.ownerContactId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === i.parentContactId) throw new ConflictError("This link would create a circular ownership structure");
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const l of await ownersOf(u, cur)) stack.push(l.get("ownerContactId"));
    }
    if (relation === "shareholder") {
      const total = (await ownersOf(u, i.parentContactId)).filter((l) => l.get("relation") === "shareholder").reduce((a, l) => a + Number(l.get("ownershipPct")), 0) + i.ownershipPct;
      if (total > 100.0001) throw new ConflictError(`Shareholdings would total ${total}% (maximum 100%)`);
    }
    try {
      const l = await u.repo("UboLink").create({ id: randomUUID(), parentContactId: i.parentContactId, ownerContactId: i.ownerContactId, ownershipPct: i.ownershipPct, relation }, { transaction: u.tx });
      await u.audit({ action: "kyc.ubo_linked", entityType: "contact", entityId: i.parentContactId, after: { ownerContactId: i.ownerContactId, pct: i.ownershipPct, relation } });
      return plain(l);
    } catch (e: any) {
      if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") throw new ConflictError("This ownership link already exists");
      throw e;
    }
  });
}

export interface UboNode { contactId: string; name: string; type: string; relation: string; directPct: number; effectivePct: number; isBeneficialOwner: boolean }

/** Effective ownership multiplies percentages along each chain; natural persons at or above the threshold (or controllers) are beneficial owners. */
export async function getUboGraph(sq: Sequelize, ctx: RequestContext, contactId: string) {
  authorize(ctx, "kyc.read");
  return withUow(sq, ctx, async (u) => {
    await visibleContact(u, ctx, "kyc.read", contactId);
    const out = new Map<string, UboNode>();
    const walk = async (parent: string, factor: number, depth: number, path: Set<string>) => {
      if (depth > 10) return;
      for (const l of await ownersOf(u, parent)) {
        const oid = l.get("ownerContactId") as string;
        if (path.has(oid)) continue;
        const direct = Number(l.get("ownershipPct"));
        const eff = l.get("relation") === "shareholder" ? factor * (direct / 100) : factor;
        const c: any = await u.repo("Contact").findById(oid, { transaction: u.tx });
        const prev = out.get(oid);
        const effectivePct = Number(((prev?.effectivePct ?? 0) + (l.get("relation") === "shareholder" ? eff * 100 : 0)).toFixed(3));
        const person = c.get("type") === "person";
        out.set(oid, {
          contactId: oid, name: [c.get("firstName"), c.get("lastName")].filter(Boolean).join(" ") || c.get("companyName") || "Unnamed", type: c.get("type"), relation: l.get("relation"),
          directPct: direct, effectivePct, isBeneficialOwner: person && (effectivePct >= UBO_THRESHOLD_PCT || l.get("relation") !== "shareholder"),
        });
        if (!person) await walk(oid, eff, depth + 1, new Set([...path, oid]));
      }
    };
    await walk(contactId, 1, 0, new Set([contactId]));
    const nodes = [...out.values()];
    return { contactId, thresholdPct: UBO_THRESHOLD_PCT, nodes, beneficialOwners: nodes.filter((n) => n.isBeneficialOwner) };
  });
}

// ---------------------------------------------------------------- screening (adapter; the AI/automation can open hits, never clear them)
export interface ScreeningSubject { contactId: string; name: string; dateOfBirth?: string | null; nationality?: string | null }
export interface ScreeningMatch { listName: string; matchedName: string; score: number; detail?: Record<string, unknown> }
export interface ScreeningProvider { code: string; screen(subject: ScreeningSubject): Promise<ScreeningMatch[]> }

/** Mock provider: matches against a tiny FICTIONAL watchlist so the workflow can be exercised. It is not a sanctions data source. */
export const mockScreening: ScreeningProvider = {
  code: "mock",
  async screen(s) {
    const n = s.name.toLowerCase();
    const out: ScreeningMatch[] = [];
    if (n.includes("testcase sanctioned")) out.push({ listName: "MOCK-SANCTIONS", matchedName: "TESTCASE SANCTIONED", score: 95 });
    if (n.includes("testcase pep")) out.push({ listName: "MOCK-PEP", matchedName: "TESTCASE PEP", score: 88, detail: { category: "pep" } });
    return out;
  },
};
const providers = new Map<string, ScreeningProvider>([["mock", mockScreening]]);
export const registerScreeningProvider = (p: ScreeningProvider) => void providers.set(p.code, p);

const nameOf = (c: any) => [c.get("firstName"), c.get("lastName")].filter(Boolean).join(" ") || c.get("companyName") || "";

async function refreshRisk(u: Uow, profile: any) {
  const id = profile.get("id");
  const contact: any = await u.repo("Contact").findById(profile.get("contactId"), { transaction: u.tx });
  const hits = (await u.repo("ScreeningHit").findAll({ where: { profileId: id }, transaction: u.tx })) as any[];
  const ubo = await ownersOf(u, profile.get("contactId"));
  const countries = [profile.get("nationality"), profile.get("countryOfResidence"), contact.get("nationality")].filter(Boolean) as string[];
  const highRisk = await tenantSetting<string[]>(u, "compliance.high_risk_countries", []);
  const r = computeRisk({
    isPep: !!profile.get("isPep"), countries, highRiskCountries: highRisk, hasSourceOfFunds: !!profile.get("sourceOfFunds"), isEntity: profile.get("subjectType") === "entity", uboIdentified: ubo.length > 0,
    openHits: hits.filter((h) => h.get("status") === "open").length, trueMatches: hits.filter((h) => h.get("status") === "true_match").length,
  });
  await u.repo("KycProfile").updateById(id, { riskScore: r.score, riskLevel: r.level, riskFactors: r.factors }, { transaction: u.tx });
  return r;
}

export async function runScreening(sq: Sequelize, ctx: RequestContext, profileId: string, providerCode = "mock") {
  authorize(ctx, "screening.run");
  const provider = providers.get(providerCode);
  if (!provider) throw new ConflictError("Unknown screening provider");
  // Gather subjects in a read transaction, call the provider outside any write transaction, then persist.
  const subjects = await withUow(sq, ctx, async (u) => {
    const p = await profileFor(u, ctx, profileId, "screening.run");
    const contact: any = await u.repo("Contact").findById(p.get("contactId"), { transaction: u.tx });
    const list: ScreeningSubject[] = [{ contactId: contact.get("id"), name: nameOf(contact), nationality: p.get("nationality") }];
    for (const l of await ownersOf(u, contact.get("id"))) {
      const o: any = await u.repo("Contact").findById(l.get("ownerContactId"), { transaction: u.tx });
      list.push({ contactId: o.get("id"), name: nameOf(o), nationality: o.get("nationality") });
    }
    return list;
  });
  const matches: Array<{ subject: ScreeningSubject; m: ScreeningMatch }> = [];
  let failed: string | null = null;
  try {
    for (const s of subjects) for (const m of await provider.screen(s)) matches.push({ subject: s, m });
  } catch (e) {
    failed = (e as Error).message;
  }
  return withUow(sq, ctx, async (u) => {
    const p = await profileFor(u, ctx, profileId, "screening.run");
    const runId = randomUUID();
    if (failed) {
      await u.repo("ScreeningRun").create({ id: runId, profileId, provider: provider.code, status: "failed", hitCount: 0, subjects: subjects.map((s) => s.contactId), triggeredBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
      throw new ConflictError(`Screening provider failed: ${failed}`);
    }
    await u.repo("ScreeningRun").create({ id: runId, profileId, provider: provider.code, status: "completed", hitCount: 0, subjects: subjects.map((s) => s.contactId), triggeredBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    let created = 0;
    let suppressed = 0;
    for (const { subject, m } of matches) {
      // A human already ruled this exact match a false positive: do not make them re-decide it on every run.
      const prior = await u.repo("ScreeningHit").findOne({ where: { profileId, subjectContactId: subject.contactId, listName: m.listName, matchedName: m.matchedName, status: { [Op.in]: ["false_positive", "open", "true_match"] } }, transaction: u.tx });
      if (prior) { suppressed++; continue; }
      await u.repo("ScreeningHit").create({ id: randomUUID(), runId, profileId, subjectContactId: subject.contactId, listName: m.listName, matchedName: m.matchedName, score: m.score, detail: m.detail ?? null, status: "open" }, { transaction: u.tx });
      created++;
    }
    await u.sq.query("UPDATE screening_runs SET hit_count=:n WHERE id=:id AND tenant_id=:t", { replacements: { n: created, id: runId, t: ctx.tenantId }, transaction: u.tx });
    if (created > 0) {
      const open: any = await u.repo("ComplianceCase").findOne({ where: { profileId, status: { [Op.in]: ["open", "escalated"] } }, transaction: u.tx });
      if (!open) {
        const caseId = randomUUID();
        await u.repo("ComplianceCase").create({ id: caseId, profileId, kind: "screening_hit", status: "open", summary: `${created} screening hit(s) require review`, openedBy: ctx.userId }, { transaction: u.tx });
        await caseEvent(u, ctx, caseId, "opened", { reason: "screening hits", hits: created });
      }
      await u.emit({ type: "screening.hits_found", aggregateType: "kyc_profile", aggregateId: profileId, payload: { hits: created } });
    }
    await refreshRisk(u, p);
    await u.audit({ action: "screening.run", entityType: "kyc_profile", entityId: profileId, after: { provider: provider.code, hits: created, suppressed } });
    return { runId, subjects: subjects.length, newHits: created, suppressedKnownHits: suppressed };
  });
}

export async function disposeHit(sq: Sequelize, ctx: RequestContext, hitId: string, i: { outcome: "true_match" | "false_positive"; reason: string }) {
  authorize(ctx, "screening.dispose");
  requireStepUp(ctx);
  if ((i.reason ?? "").trim().length < 10) throw new ConflictError("A written reason of at least 10 characters is required to dispose a hit");
  return withUow(sq, ctx, async (u) => {
    const h: any = await u.repo("ScreeningHit").findById(hitId, { transaction: u.tx });
    if (!h) throw new NotFoundError("Screening hit");
    const p = await profileFor(u, ctx, h.get("profileId"), "screening.dispose");
    if (h.get("status") !== "open") throw new ConflictError("This hit has already been disposed");
    await u.repo("ScreeningHit").updateById(hitId, { status: i.outcome, disposedBy: ctx.userId, disposedReason: i.reason.trim(), disposedAt: new Date() }, { transaction: u.tx });
    if (i.outcome === "true_match" && String(h.get("listName")).includes("PEP")) await u.repo("KycProfile").updateById(p.get("id"), { isPep: true }, { transaction: u.tx });
    if (i.outcome === "true_match") {
      const open: any = await u.repo("ComplianceCase").findOne({ where: { profileId: p.get("id"), status: { [Op.in]: ["open", "escalated"] } }, transaction: u.tx });
      if (open) { await u.repo("ComplianceCase").updateById(open.get("id"), { status: "escalated" }, { transaction: u.tx }); await caseEvent(u, ctx, open.get("id"), "escalated", { reason: "confirmed match" }); }
    }
    await refreshRisk(u, await u.repo("KycProfile").findById(p.get("id"), { transaction: u.tx }));
    await u.audit({ action: "screening.hit_disposed", entityType: "kyc_profile", entityId: p.get("id"), after: { hitId, outcome: i.outcome }, reason: i.reason.trim() });
    return plain(await u.repo("ScreeningHit").findById(hitId, { transaction: u.tx }));
  });
}

// ---------------------------------------------------------------- submission and review (maker-checker)
export async function submitKyc(sq: Sequelize, ctx: RequestContext, profileId: string) {
  authorize(ctx, "kyc.manage");
  return withUow(sq, ctx, async (u) => {
    const p = await profileFor(u, ctx, profileId, "kyc.manage");
    if (!["draft", "rejected", "expired"].includes(p.get("status"))) throw new ConflictError(`A ${p.get("status")} profile cannot be submitted`);
    const reasons: string[] = [];
    if (!p.get("idNumberEnc")) reasons.push("An identity number is required");
    const docs = await u.repo("KycDocument").count({ where: { profileId }, transaction: u.tx });
    if (!docs) reasons.push("At least one identity document is required");
    if (p.get("subjectType") === "entity" && !(await ownersOf(u, p.get("contactId"))).length) reasons.push("An entity needs at least one beneficial-ownership link");
    if (reasons.length) throw new ConflictError(reasons.join("; "));
    await u.repo("KycProfile").updateById(profileId, { status: "in_review", submittedAt: new Date(), submittedBy: ctx.userId, reviewedBy: null, reviewedAt: null, decisionReason: null }, { transaction: u.tx });
    await refreshRisk(u, await u.repo("KycProfile").findById(profileId, { transaction: u.tx }));
    await u.audit({ action: "kyc.submitted", entityType: "kyc_profile", entityId: profileId });
    return viewProfile(u, ctx, profileId);
  });
}

export async function reviewKyc(sq: Sequelize, ctx: RequestContext, profileId: string, i: { outcome: "approved" | "rejected"; reason: string }) {
  authorize(ctx, "kyc.review");
  if (!i.reason?.trim()) throw new ConflictError("A reason is required");
  return withUow(sq, ctx, async (u) => {
    const p = await profileFor(u, ctx, profileId, "kyc.review");
    if (p.get("status") !== "in_review") throw new ConflictError("Only a profile in review can be decided");
    if (p.get("submittedBy") === ctx.userId) throw new ConflictError("The person who submitted a profile cannot also approve it");
    if (i.outcome === "approved") {
      const hits = (await u.repo("ScreeningHit").findAll({ where: { profileId }, transaction: u.tx })) as any[];
      if (hits.some((h) => h.get("status") === "open")) throw new ConflictError("Screening hits are still awaiting disposition");
      if (hits.some((h) => h.get("status") === "true_match") && !hasPermission(ctx, "compliance.override")) throw new ConflictError("A confirmed screening match needs a senior (compliance.override) approval");
      const open = await u.repo("ComplianceCase").count({ where: { profileId, status: { [Op.in]: ["open", "escalated"] } }, transaction: u.tx });
      if (open) throw new ConflictError("Close the open compliance case first");
      const risk = await refreshRisk(u, p);
      if (risk.level === "high" && !hasPermission(ctx, "compliance.override")) throw new ConflictError("A high-risk profile needs a senior (compliance.override) approval");
      const expired = (await u.repo("KycDocument").findAll({ where: { profileId, expiresOn: { [Op.lt]: today() } }, transaction: u.tx })) as any[];
      if (expired.length) throw new ConflictError("An identity document on file has expired");
    }
    const validity = await tenantSetting<number>(u, "compliance.kyc_validity_days", 365);
    await u.repo("KycProfile").updateById(profileId, {
      status: i.outcome, reviewedBy: ctx.userId, reviewedAt: new Date(), decisionReason: i.reason.trim(), expiresAt: i.outcome === "approved" ? addDaysIso(today(), validity) : null,
    }, { transaction: u.tx });
    await u.audit({ action: `kyc.${i.outcome}`, entityType: "kyc_profile", entityId: profileId, reason: i.reason.trim() });
    await u.emit({ type: `kyc.${i.outcome}`, aggregateType: "kyc_profile", aggregateId: profileId, payload: { contactId: p.get("contactId") } });
    return viewProfile(u, ctx, profileId);
  });
}

/** Authorised, audited reveal of the stored identity number (e.g. for a regulatory filing). Needs step-up. */
export async function revealIdentity(sq: Sequelize, ctx: RequestContext, profileId: string, reason: string) {
  authorize(ctx, "kyc.review");
  requireStepUp(ctx);
  if (!reason?.trim()) throw new ConflictError("A reason is required");
  return withUow(sq, ctx, async (u) => {
    const p = await profileFor(u, ctx, profileId, "kyc.review");
    await u.audit({ action: "kyc.identity_revealed", entityType: "kyc_profile", entityId: profileId, reason: reason.trim() });
    return { idType: p.get("idType"), idNumber: p.get("idNumberEnc") ? decryptField(p.get("idNumberEnc")) : null, dateOfBirth: p.get("dateOfBirthEnc") ? decryptField(p.get("dateOfBirthEnc")) : null };
  });
}

// ---------------------------------------------------------------- cases
export async function openCase(sq: Sequelize, ctx: RequestContext, i: { profileId: string; kind: string; summary: string; assignedUserId?: string }) {
  authorize(ctx, "case.manage");
  return withUow(sq, ctx, async (u) => {
    await profileFor(u, ctx, i.profileId, "case.manage");
    if (i.assignedUserId && !(await u.repo("User").findOne({ where: { id: i.assignedUserId, status: "active" }, transaction: u.tx }))) throw new NotFoundError("Assignee");
    const id = randomUUID();
    await u.repo("ComplianceCase").create({ id, profileId: i.profileId, kind: i.kind, status: "open", summary: i.summary, assignedUserId: i.assignedUserId ?? null, openedBy: ctx.userId }, { transaction: u.tx });
    await caseEvent(u, ctx, id, "opened", { kind: i.kind });
    await u.audit({ action: "case.opened", entityType: "compliance_case", entityId: id, after: { kind: i.kind } });
    return getCaseInUow(u, id);
  });
}

async function getCaseInUow(u: Uow, id: string) {
  const c: any = await u.repo("ComplianceCase").findById(id, { transaction: u.tx });
  if (!c) throw new NotFoundError("Case");
  const events = await u.repo("CaseEvent").findAll({ where: { caseId: id }, order: [["createdAt", "ASC"]], transaction: u.tx });
  return { ...plain(c), events: events.map(plain) };
}
export const getCase = (sq: Sequelize, ctx: RequestContext, id: string) => { authorize(ctx, "case.read"); return withUow(sq, ctx, (u) => getCaseInUow(u, id)); };
export async function listCases(sq: Sequelize, ctx: RequestContext, f: { status?: string; limit: number; offset: number }) {
  authorize(ctx, "case.read");
  return withUow(sq, ctx, async (u) => (await u.repo("ComplianceCase").findAll({ where: f.status ? { status: f.status } : {}, order: [["createdAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain));
}

export async function assignCase(sq: Sequelize, ctx: RequestContext, id: string, userId: string) {
  authorize(ctx, "case.manage");
  return withUow(sq, ctx, async (u) => {
    const c: any = await u.repo("ComplianceCase").findById(id, { transaction: u.tx });
    if (!c) throw new NotFoundError("Case");
    if (c.get("status") === "closed") throw new ConflictError("The case is closed");
    if (!(await u.repo("User").findOne({ where: { id: userId, status: "active" }, transaction: u.tx }))) throw new NotFoundError("Assignee");
    await u.repo("ComplianceCase").updateById(id, { assignedUserId: userId }, { transaction: u.tx });
    await caseEvent(u, ctx, id, "assigned", { userId });
    return getCaseInUow(u, id);
  });
}

export async function addCaseNote(sq: Sequelize, ctx: RequestContext, id: string, note: string) {
  authorize(ctx, "case.manage");
  return withUow(sq, ctx, async (u) => {
    const c: any = await u.repo("ComplianceCase").findById(id, { transaction: u.tx });
    if (!c) throw new NotFoundError("Case");
    if (c.get("status") === "closed") throw new ConflictError("The case is closed");
    await caseEvent(u, ctx, id, "note", { note });
    return getCaseInUow(u, id);
  });
}

export async function closeCase(sq: Sequelize, ctx: RequestContext, id: string, i: { outcome: "cleared" | "reported" | "rejected"; resolution: string }) {
  authorize(ctx, "case.manage");
  if ((i.resolution ?? "").trim().length < 10) throw new ConflictError("A written resolution of at least 10 characters is required");
  return withUow(sq, ctx, async (u) => {
    const c: any = await u.repo("ComplianceCase").findById(id, { transaction: u.tx });
    if (!c) throw new NotFoundError("Case");
    if (c.get("status") === "closed") throw new ConflictError("The case is already closed");
    const profileId = c.get("profileId");
    if (i.outcome === "cleared") {
      if (await u.repo("ScreeningHit").count({ where: { profileId, status: "open" }, transaction: u.tx })) throw new ConflictError("Dispose every open screening hit before clearing the case");
      if (await u.repo("ScreeningHit").count({ where: { profileId, status: "true_match" }, transaction: u.tx }) && !hasPermission(ctx, "compliance.override")) throw new ConflictError("Clearing a case with a confirmed match needs compliance.override");
    }
    await u.repo("ComplianceCase").updateById(id, { status: "closed", outcome: i.outcome, closedBy: ctx.userId, closedAt: new Date(), resolution: i.resolution.trim() }, { transaction: u.tx });
    if (i.outcome === "rejected") await u.repo("KycProfile").updateById(profileId, { status: "rejected", reviewedBy: ctx.userId, reviewedAt: new Date(), decisionReason: i.resolution.trim() }, { transaction: u.tx });
    await caseEvent(u, ctx, id, "closed", { outcome: i.outcome });
    await u.audit({ action: "case.closed", entityType: "compliance_case", entityId: id, after: { outcome: i.outcome }, reason: i.resolution.trim() });
    await u.emit({ type: "case.closed", aggregateType: "compliance_case", aggregateId: id, payload: { outcome: i.outcome } });
    return getCaseInUow(u, id);
  });
}

// ---------------------------------------------------------------- regulatory export (goAML-STYLE: not validated against the FIU schema)
const xml = (s: unknown) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/**
 * Builds a goAML-style XML file for cases closed as "reported". It is a structured hand-off for the MLRO, NOT a validated FIU submission:
 * the real schema, report codes and filing channel must be confirmed by the compliance function. Identity numbers are masked (last 4).
 */
export async function exportReportedCases(sq: Sequelize, ctx: RequestContext, f: { from: string; to: string }) {
  authorize(ctx, "aml.export");
  requireStepUp(ctx);
  return withUow(sq, ctx, async (u) => {
    const cases = (await u.repo("ComplianceCase").findAll({ where: { status: "closed", outcome: "reported", closedAt: { [Op.gte]: new Date(f.from), [Op.lt]: new Date(f.to) } }, order: [["closedAt", "ASC"]], transaction: u.tx })) as any[];
    const parts: string[] = [];
    for (const c of cases) {
      const p: any = await u.repo("KycProfile").findById(c.get("profileId"), { transaction: u.tx });
      const contact: any = await u.repo("Contact").findById(p.get("contactId"), { transaction: u.tx });
      const hits = (await u.repo("ScreeningHit").findAll({ where: { profileId: p.get("id"), status: "true_match" }, transaction: u.tx })) as any[];
      parts.push(
        `  <report id="${xml(c.get("id"))}" closedAt="${xml(new Date(c.get("closedAt")).toISOString())}">\n` +
        `    <subject type="${xml(p.get("subjectType"))}"><name>${xml(nameOf(contact))}</name><nationality>${xml(p.get("nationality"))}</nationality>` +
        `<idType>${xml(p.get("idType"))}</idType><idNumberLast4>${xml(p.get("idNumberLast4"))}</idNumberLast4><pep>${p.get("isPep") ? "true" : "false"}</pep></subject>\n` +
        `    <reason>${xml(c.get("summary"))}</reason><resolution>${xml(c.get("resolution"))}</resolution>\n` +
        `    <matches>${hits.map((h) => `<match list="${xml(h.get("listName"))}" name="${xml(h.get("matchedName"))}" score="${h.get("score")}"/>`).join("")}</matches>\n  </report>`,
      );
    }
    const doc = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- goAML-style export. NOT validated against the FIU schema; review before any filing. -->\n<reports count="${cases.length}" from="${xml(f.from)}" to="${xml(f.to)}">\n${parts.join("\n")}\n</reports>\n`;
    await u.audit({ action: "aml.exported", entityType: "tenant", entityId: ctx.tenantId, after: { count: cases.length, from: f.from, to: f.to } });
    return { count: cases.length, xml: doc };
  });
}

// ---------------------------------------------------------------- deal gate (opt-in per tenant)
/**
 * When the tenant setting `compliance.kyc_required_for_deals` is true, a deal cannot leave "reserved" until the buyer/tenant has an approved,
 * unexpired KYC profile with no open hits or cases. Off by default so existing tenants are not blocked on enablement.
 */
registerDealGate(async (u, deal, to) => {
  if (to === "reserved" || to === "cancelled") return [];
  if (!(await tenantSetting<boolean>(u, "compliance.kyc_required_for_deals", false))) return [];
  const contactId = deal.get("contactId");
  const p: any = await u.repo("KycProfile").findOne({ where: { contactId }, transaction: u.tx });
  if (!p) return ["The buyer has no KYC profile"];
  const reasons: string[] = [];
  if (p.get("status") !== "approved") reasons.push(`The buyer's KYC is ${p.get("status")}`);
  else if (p.get("expiresAt") && p.get("expiresAt") < today()) reasons.push("The buyer's KYC has expired");
  if (await u.repo("ScreeningHit").count({ where: { profileId: p.get("id"), status: "open" }, transaction: u.tx })) reasons.push("Screening hits are awaiting disposition");
  if (await u.repo("ComplianceCase").count({ where: { profileId: p.get("id"), status: { [Op.in]: ["open", "escalated"] } }, transaction: u.tx })) reasons.push("A compliance case is open for the buyer");
  return reasons;
});

// ---------------------------------------------------------------- scheduled work
export async function kycExpirySweep(sq: Sequelize, ctx: RequestContext) {
  assertSweepAllowed(ctx, "kyc.review");
  return withUow(sq, ctx, async (u) => {
    const due = (await u.repo("KycProfile").findAll({ where: { status: "approved", expiresAt: { [Op.lt]: today() } }, transaction: u.tx })) as any[];
    for (const p of due) {
      await u.repo("KycProfile").updateById(p.get("id"), { status: "expired" }, { transaction: u.tx });
      await u.emit({ type: "kyc.expired", aggregateType: "kyc_profile", aggregateId: p.get("id"), payload: { contactId: p.get("contactId") } });
    }
    return due.length;
  });
}
