import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { RequestContext, systemContext } from "@reales/database";
import { requireStepUp } from "@reales/auth";
import { authorize } from "@reales/rbac";
import { tenantSetting } from "./compliance";
import { plain } from "./scope";
import { assertSweepAllowed, ConflictError, NotFoundError, Uow, withUow } from "./uow";

const DAY = 86_400_000;
const nameOf = (c: any) => [c.get("firstName"), c.get("lastName")].filter(Boolean).join(" ") || c.get("companyName") || "Unnamed";

// ---------------------------------------------------------------- legal holds
export async function placeLegalHold(sq: Sequelize, ctx: RequestContext, contactId: string, reason: string) {
  authorize(ctx, "retention.manage");
  if (!reason?.trim()) throw new ConflictError("A reason is required");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Contact").findById(contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    const h = await u.repo("LegalHold").create({ id: randomUUID(), contactId, reason: reason.trim(), placedBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: "legal_hold.placed", entityType: "contact", entityId: contactId, reason: reason.trim() });
    return plain(h);
  });
}

export async function releaseLegalHold(sq: Sequelize, ctx: RequestContext, holdId: string) {
  authorize(ctx, "retention.manage");
  requireStepUp(ctx);
  return withUow(sq, ctx, async (u) => {
    const h: any = await u.repo("LegalHold").findById(holdId, { transaction: u.tx });
    if (!h) throw new NotFoundError("Legal hold");
    if (h.get("releasedAt")) throw new ConflictError("The hold was already released");
    await u.repo("LegalHold").updateById(holdId, { releasedAt: new Date(), releasedBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: "legal_hold.released", entityType: "contact", entityId: h.get("contactId") });
    return plain(await u.repo("LegalHold").findById(holdId, { transaction: u.tx }));
  });
}

export async function listLegalHolds(sq: Sequelize, ctx: RequestContext, f: { contactId?: string; activeOnly?: boolean }) {
  authorize(ctx, "retention.manage");
  return withUow(sq, ctx, async (u) => (await u.repo("LegalHold").findAll({ where: { ...(f.contactId ? { contactId: f.contactId } : {}), ...(f.activeOnly ? { releasedAt: null } : {}) }, order: [["createdAt", "DESC"]], transaction: u.tx })).map(plain));
}

const onHold = async (u: Uow, contactId: string) => (await u.repo("LegalHold").count({ where: { contactId, releasedAt: null }, transaction: u.tx })) > 0;

// ---------------------------------------------------------------- data-subject requests
export type DsrKind = "access" | "rectification" | "erasure" | "restriction";

/** The response period is configuration (`compliance.dsr_days`, default 30): confirm the legally applicable period with counsel. */
export async function createDsr(sq: Sequelize, ctx: RequestContext, i: { contactId: string; kind: DsrKind; note?: string }) {
  authorize(ctx, "dsr.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Contact").findById(i.contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    const days = await tenantSetting<number>(u, "compliance.dsr_days", 30);
    const id = randomUUID();
    await u.repo("DsrRequest").create({ id, contactId: i.contactId, kind: i.kind, status: "received", dueAt: new Date(Date.now() + days * DAY), note: i.note ?? null, handledBy: null }, { transaction: u.tx });
    await u.audit({ action: "dsr.received", entityType: "contact", entityId: i.contactId, after: { kind: i.kind, requestId: id } });
    return plain(await u.repo("DsrRequest").findById(id, { transaction: u.tx }));
  });
}

export async function listDsr(sq: Sequelize, ctx: RequestContext, f: { status?: string; limit: number; offset: number }) {
  authorize(ctx, "dsr.manage");
  return withUow(sq, ctx, async (u) => (await u.repo("DsrRequest").findAll({ where: f.status ? { status: f.status } : {}, order: [["dueAt", "ASC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain));
}

async function openDsr(u: Uow, id: string, kind?: DsrKind) {
  const r: any = await u.repo("DsrRequest").findById(id, { transaction: u.tx });
  if (!r) throw new NotFoundError("Request");
  if (r.get("status") !== "received") throw new ConflictError(`The request is already ${r.get("status")}`);
  if (kind && r.get("kind") !== kind) throw new ConflictError(`This is a ${r.get("kind")} request`);
  return r;
}

/** Subject-access package. KYC identity data is masked: the package confirms it exists without disclosing stored numbers. */
export async function fulfilAccessRequest(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "dsr.manage");
  return withUow(sq, ctx, async (u) => {
    const r = await openDsr(u, id, "access");
    const contactId = r.get("contactId");
    const contact: any = await u.repo("Contact").findById(contactId, { transaction: u.tx });
    const [consent, leads, kyc, conversations, deals, viewings] = await Promise.all([
      u.repo("ConsentRecord").findAll({ where: { contactId }, transaction: u.tx }),
      u.repo("Lead").findAll({ where: { contactId }, transaction: u.tx }),
      u.repo("KycProfile").findOne({ where: { contactId }, transaction: u.tx }),
      u.repo("Conversation").findAll({ where: { contactId }, transaction: u.tx }),
      u.repo("Deal").findAll({ where: { contactId }, transaction: u.tx }),
      u.repo("Viewing").findAll({ where: { contactId }, transaction: u.tx }),
    ]);
    const messages = conversations.length
      ? ((await u.sq.query<any>("SELECT direction, channel, body, occurred_at FROM messages WHERE tenant_id=:t AND conversation_id IN (:ids) ORDER BY occurred_at", { replacements: { t: ctx.tenantId, ids: conversations.map((c: any) => c.get("id")) }, transaction: u.tx, type: QueryTypes.SELECT })) as any[])
      : [];
    const result = {
      generatedAt: new Date().toISOString(),
      contact: plain(contact),
      consent: consent.map(plain),
      leads: leads.map((l: any) => ({ id: l.get("id"), purpose: l.get("purpose"), status: l.get("status"), createdAt: l.get("createdAt") })),
      viewings: viewings.map((v: any) => ({ id: v.get("id"), scheduledAt: v.get("scheduledAt"), status: v.get("status") })),
      deals: deals.map((d: any) => ({ id: d.get("id"), stage: d.get("stage"), amount: d.get("amount"), currency: d.get("currency") })),
      messages,
      kyc: kyc ? { status: kyc.get("status"), riskLevel: kyc.get("riskLevel"), idType: kyc.get("idType"), idNumberLast4: kyc.get("idNumberLast4"), nationality: kyc.get("nationality"), note: "Full identity numbers are held encrypted and are not included in this export." } : null,
    };
    await u.repo("DsrRequest").updateById(id, { status: "completed", completedAt: new Date(), handledBy: ctx.userId, result }, { transaction: u.tx });
    await u.audit({ action: "dsr.access_fulfilled", entityType: "contact", entityId: contactId, after: { requestId: id, messages: messages.length } });
    return plain(await u.repo("DsrRequest").findById(id, { transaction: u.tx }));
  });
}

/** Records a retention obligation per category so an erasure response is explicit about what was kept and why. */
async function amlRetentionDays(u: Uow) { return tenantSetting<number>(u, "compliance.aml_retention_days", 1825); }

/** Anonymise the identity on the contact row and in message bodies. Referential records (deals, invoices, payments) keep their ids but lose the person. */
async function anonymiseContact(u: Uow, tenantId: string, contactId: string) {
  await u.repo("Contact").updateById(contactId, { firstName: "Erased", lastName: null, companyName: null, email: null, normalizedEmail: null, phoneE164: null, nationality: null, language: null, status: "archived" }, { transaction: u.tx });
  await u.sq.query("UPDATE messages SET body='[erased]', subject=NULL WHERE tenant_id=:t AND conversation_id IN (SELECT id FROM conversations WHERE tenant_id=:t AND contact_id=:c)", { replacements: { t: tenantId, c: contactId }, transaction: u.tx });
}

export interface ErasureOutcome { anonymised: string[]; retained: Array<{ what: string; reason: string }> }

async function erasePlan(u: Uow, contactId: string) {
  const retained: ErasureOutcome["retained"] = [];
  const days = await amlRetentionDays(u);
  const kyc: any = await u.repo("KycProfile").findOne({ where: { contactId }, transaction: u.tx });
  const kycWithin = kyc && Date.now() - new Date(kyc.get("createdAt")).getTime() < days * DAY;
  if (kycWithin) retained.push({ what: "KYC/AML records", reason: `Kept for the configured AML retention period (${days} days)` });
  const finance = (await u.repo("Invoice").count({ where: { contactId }, transaction: u.tx })) + (await u.repo("Payment").count({ where: { contactId }, transaction: u.tx })) + (await u.repo("Deal").count({ where: { contactId }, transaction: u.tx }));
  if (finance) retained.push({ what: "Transaction and financial records", reason: "Kept as the company's financial and contractual record; the person's identity on the contact is anonymised" });
  return { retained, kyc, kycWithin };
}

export async function fulfilErasureRequest(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "dsr.manage");
  requireStepUp(ctx);
  return withUow(sq, ctx, async (u) => {
    const r = await openDsr(u, id, "erasure");
    const contactId = r.get("contactId");
    if (await onHold(u, contactId)) throw new ConflictError("The contact is under a legal hold; erasure is blocked until it is released");
    const plan = await erasePlan(u, contactId);
    await anonymiseContact(u, ctx.tenantId, contactId);
    const anonymised = ["contact identity", "message bodies"];
    if (plan.kyc && !plan.kycWithin) {
      await u.repo("KycProfile").updateById(plan.kyc.get("id"), { idNumberEnc: null, idNumberLast4: null, dateOfBirthEnc: null, nationality: null, countryOfResidence: null, sourceOfFunds: null, occupation: null }, { transaction: u.tx });
      anonymised.push("KYC identity fields");
    }
    const result: ErasureOutcome = { anonymised, retained: plan.retained };
    await u.repo("DsrRequest").updateById(id, { status: "completed", completedAt: new Date(), handledBy: ctx.userId, result }, { transaction: u.tx });
    await u.audit({ action: "dsr.erasure_fulfilled", entityType: "contact", entityId: contactId, after: { requestId: id, retained: plan.retained.length } });
    await u.emit({ type: "contact.erased", aggregateType: "contact", aggregateId: contactId, payload: { requestId: id } });
    return plain(await u.repo("DsrRequest").findById(id, { transaction: u.tx }));
  });
}

export async function closeDsr(sq: Sequelize, ctx: RequestContext, id: string, i: { outcome: "completed" | "rejected"; note: string }) {
  authorize(ctx, "dsr.manage");
  if (!i.note?.trim()) throw new ConflictError("A note is required");
  return withUow(sq, ctx, async (u) => {
    const r = await openDsr(u, id);
    if (i.outcome === "completed" && r.get("kind") !== "rectification" && r.get("kind") !== "restriction") throw new ConflictError("Access and erasure requests are completed through their own actions");
    await u.repo("DsrRequest").updateById(id, { status: i.outcome, completedAt: new Date(), handledBy: ctx.userId, note: i.note.trim() }, { transaction: u.tx });
    await u.audit({ action: `dsr.${i.outcome}`, entityType: "contact", entityId: r.get("contactId"), after: { requestId: id }, reason: i.note.trim() });
    return plain(await u.repo("DsrRequest").findById(id, { transaction: u.tx }));
  });
}

/** Flags requests past their due date once so the compliance team is told before the deadline is missed again. */
export async function dsrSweep(sq: Sequelize, ctx: RequestContext, now = new Date()) {
  assertSweepAllowed(ctx, "dsr.manage");
  return withUow(sq, ctx, async (u) => {
    const late = (await u.repo("DsrRequest").findAll({ where: { status: "received", dueAt: { [Op.lt]: now }, overdueNotifiedAt: null }, transaction: u.tx })) as any[];
    for (const r of late) {
      await u.repo("DsrRequest").updateById(r.get("id"), { overdueNotifiedAt: now }, { transaction: u.tx });
      await u.emit({ type: "dsr.overdue", aggregateType: "dsr_request", aggregateId: r.get("id"), payload: { kind: r.get("kind"), dueAt: r.get("dueAt") } });
    }
    return late.length;
  });
}

// ---------------------------------------------------------------- retention
export async function setRetentionPolicy(sq: Sequelize, ctx: RequestContext, i: { entityType: "contact_archived" | "kyc_profile" | "message"; retainDays: number; action?: "anonymise" | "delete_content" }) {
  authorize(ctx, "retention.manage");
  if (!(Number.isInteger(i.retainDays) && i.retainDays >= 30)) throw new ConflictError("Retention must be at least 30 days");
  return withUow(sq, ctx, async (u) => {
    const ex: any = await u.repo("RetentionPolicy").findOne({ where: { entityType: i.entityType }, transaction: u.tx });
    if (ex) await u.repo("RetentionPolicy").updateById(ex.get("id"), { retainDays: i.retainDays, action: i.action ?? "anonymise" }, { transaction: u.tx });
    else await u.repo("RetentionPolicy").create({ id: randomUUID(), entityType: i.entityType, retainDays: i.retainDays, action: i.action ?? "anonymise" }, { transaction: u.tx });
    await u.audit({ action: "retention.policy_set", entityType: "tenant", entityId: ctx.tenantId, after: i });
    return plain(await u.repo("RetentionPolicy").findOne({ where: { entityType: i.entityType }, transaction: u.tx }));
  });
}
export async function listRetentionPolicies(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "retention.manage");
  return withUow(sq, ctx, async (u) => (await u.repo("RetentionPolicy").findAll({ transaction: u.tx })).map(plain));
}

export interface RetentionReport { dryRun: boolean; contactsAnonymised: number; skippedLegalHold: number; skippedRetention: number }

/**
 * Applies the `contact_archived` policy: archived contacts untouched for `retainDays` are anonymised, unless a legal hold or the AML retention
 * period applies. Destructive, so it is only ever run on request (dry-run by default) and never from the scheduler.
 */
export async function runRetention(sq: Sequelize, ctx: RequestContext, o: { dryRun?: boolean } = {}): Promise<RetentionReport> {
  authorize(ctx, "retention.manage");
  const dryRun = o.dryRun ?? true;
  if (!dryRun) requireStepUp(ctx);
  return withUow(sq, ctx, async (u) => {
    const out: RetentionReport = { dryRun, contactsAnonymised: 0, skippedLegalHold: 0, skippedRetention: 0 };
    const pol: any = await u.repo("RetentionPolicy").findOne({ where: { entityType: "contact_archived" }, transaction: u.tx });
    if (!pol) return out;
    const cutoff = new Date(Date.now() - Number(pol.get("retainDays")) * DAY);
    const stale = (await u.repo("Contact").findAll({ where: { status: "archived", updatedAt: { [Op.lt]: cutoff }, firstName: { [Op.ne]: "Erased" } }, transaction: u.tx })) as any[];
    for (const c of stale) {
      if (await onHold(u, c.get("id"))) { out.skippedLegalHold++; continue; }
      const plan = await erasePlan(u, c.get("id"));
      if (plan.kycWithin) { out.skippedRetention++; continue; }
      if (!dryRun) await anonymiseContact(u, ctx.tenantId, c.get("id"));
      out.contactsAnonymised++;
    }
    if (!dryRun) await u.audit({ action: "retention.run", entityType: "tenant", entityId: ctx.tenantId, after: out });
    return out;
  });
}

void systemContext;
void nameOf;
