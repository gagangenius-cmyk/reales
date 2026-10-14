import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import { mysqlDate, RequestContext, systemContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { loadVersionBytes } from "./documents";
import { completeMilestoneInUow, DEAL_SCOPE } from "./deals";
import { getSignatureProvider, SignatureEvidence, SignatureWebhookEvent } from "./providers";
import { plain, scopeWhere } from "./scope";
import { assertProviderAllowed } from "./hardening";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";
import { normalizeEmail } from "./normalize";

async function assertSignAccess(u: Uow, ctx: RequestContext, dealId: string | null | undefined) {
  if (!dealId) return authorize(ctx, "signature.manage");
  const scope = await scopeWhere(u, ctx, "deal.read", DEAL_SCOPE);
  const d: any = await u.repo("Deal").findOne({ where: { [Op.and]: [{ id: dealId }, scope] }, transaction: u.tx });
  if (!d) throw new NotFoundError("Deal");
  authorize(ctx, "signature.manage", { ownerUserId: d.get("agentUserId"), branchId: d.get("branchId"), projectId: d.get("projectId") });
}

async function sigEvent(u: Uow, envelopeId: string, type: string, payload: unknown) {
  await u.repo("SignatureEvent").create({ id: randomUUID(), envelopeId, type, payload, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
}

export interface CreateEnvelopeInput {
  documentId: string; version?: number; dealId?: string; provider?: string;
  signers: Array<{ name: string; email: string; contactId?: string; order?: number }>;
}

/** The envelope pins the exact document VERSION and its content hash: what is signed is provably what was uploaded. */
export async function createEnvelope(sq: Sequelize, ctx: RequestContext, i: CreateEnvelopeInput) {
  return withUow(sq, ctx, async (u) => {
    await assertSignAccess(u, ctx, i.dealId);
    if (!i.signers.length) throw new ConflictError("At least one signer is required");
    const emails = i.signers.map((s) => normalizeEmail(s.email));
    if (emails.some((e) => !e)) throw new ConflictError("Every signer needs a valid email address");
    if (new Set(emails).size !== emails.length) throw new ConflictError("Signers must have distinct email addresses");
    const provider = getSignatureProvider(i.provider ?? "mock");
    if (!provider) throw new ConflictError("Unknown signature provider");
    await assertProviderAllowed(u, provider.code);
    const doc: any = await u.repo("Document").findById(i.documentId, { transaction: u.tx });
    if (!doc) throw new NotFoundError("Document");
    if (i.dealId) {
      const linked = await u.repo("DocumentLink").findOne({ where: { documentId: i.documentId, entityType: "deal", entityId: i.dealId }, transaction: u.tx });
      if (!linked) throw new ConflictError("The document must be attached to the deal before it is sent for signature");
    }
    const version = i.version ?? doc.get("currentVersion");
    const loaded = await loadVersionBytes(u, i.documentId, version);
    const created = await provider.createEnvelope({ subject: doc.get("title"), documentName: loaded.filename, contentHash: loaded.hash, bytes: loaded.bytes });
    const id = randomUUID();
    await u.repo("SignatureEnvelope").create({
      id, documentId: i.documentId, documentVersion: version, contentHash: loaded.hash, provider: provider.code, providerEnvelopeId: created.providerEnvelopeId,
      dealId: i.dealId ?? null, status: "draft", createdBy: ctx.userId,
    }, { transaction: u.tx });
    for (const [idx, s] of i.signers.entries()) {
      await provider.addSigner(created.providerEnvelopeId, { name: s.name, email: emails[idx]!, order: s.order ?? idx + 1 });
      await u.repo("SignatureSigner").create({ id: randomUUID(), envelopeId: id, contactId: s.contactId ?? null, name: s.name, email: emails[idx], signOrder: s.order ?? idx + 1, status: "pending" }, { transaction: u.tx });
    }
    await sigEvent(u, id, "envelope.created", { documentVersion: version, contentHash: loaded.hash });
    return plain(await u.repo("SignatureEnvelope").findById(id, { transaction: u.tx }));
  });
}

async function scopedEnvelope(u: Uow, ctx: RequestContext, id: string) {
  const env: any = await u.repo("SignatureEnvelope").findById(id, { transaction: u.tx });
  if (!env) throw new NotFoundError("Envelope");
  await assertSignAccess(u, ctx, env.get("dealId"));
  return env;
}

export async function sendEnvelope(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const env = await scopedEnvelope(u, ctx, id);
    if (env.get("status") !== "draft") throw new ConflictError(`A ${env.get("status")} envelope cannot be sent`);
    // Re-verify the stored bytes still match the pinned hash immediately before sending.
    const loaded = await loadVersionBytes(u, env.get("documentId"), env.get("documentVersion"));
    if (loaded.hash !== env.get("contentHash")) throw new ConflictError("The document no longer matches the envelope");
    await getSignatureProvider(env.get("provider"))!.send(env.get("providerEnvelopeId"));
    await u.repo("SignatureEnvelope").updateById(id, { status: "sent", sentAt: new Date() }, { transaction: u.tx });
    await sigEvent(u, id, "envelope.sent", {});
    await u.audit({ action: "signature.sent", entityType: "signature_envelope", entityId: id, after: { documentId: env.get("documentId"), version: env.get("documentVersion") } });
    await u.emit({ type: "signature.sent", aggregateType: "signature_envelope", aggregateId: id, payload: { dealId: env.get("dealId") } });
    return plain(await u.repo("SignatureEnvelope").findById(id, { transaction: u.tx }));
  });
}

export async function cancelEnvelope(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  if (!reason?.trim()) throw new ConflictError("A reason is required");
  return withUow(sq, ctx, async (u) => {
    const env = await scopedEnvelope(u, ctx, id);
    if (!["draft", "sent"].includes(env.get("status"))) throw new ConflictError(`A ${env.get("status")} envelope cannot be cancelled`);
    await getSignatureProvider(env.get("provider"))!.cancel(env.get("providerEnvelopeId"));
    await u.repo("SignatureEnvelope").updateById(id, { status: "cancelled" }, { transaction: u.tx });
    await sigEvent(u, id, "envelope.cancelled", { reason });
    await u.audit({ action: "signature.cancelled", entityType: "signature_envelope", entityId: id, reason });
    return plain(await u.repo("SignatureEnvelope").findById(id, { transaction: u.tx }));
  });
}

export async function getEnvelope(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const env = await scopedEnvelope(u, ctx, id);
    const [signers, events] = await Promise.all([
      u.repo("SignatureSigner").findAll({ where: { envelopeId: id }, order: [["signOrder", "ASC"]], transaction: u.tx }),
      u.repo("SignatureEvent").findAll({ where: { envelopeId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
    ]);
    return { ...plain(env), signers: signers.map(plain), events: events.map(plain) };
  });
}

export type SignatureOutcome = "applied" | "completed" | "declined" | "ignored" | "tamper_detected";

/**
 * Apply a VERIFIED provider callback. Idempotent (a signer can only sign once), order-enforcing, and it re-checks the stored
 * document hash before declaring the envelope complete. Completion records the evidence package and unlocks the deal milestone.
 */
export async function applySignatureEvent(sq: Sequelize, tenantId: string, ev: SignatureWebhookEvent, providerCode: string): Promise<SignatureOutcome> {
  const ctx = systemContext(tenantId, `corr_${randomUUID()}`);
  return withUow(sq, ctx, async (u) => {
    const env: any = await u.repo("SignatureEnvelope").findOne({ where: { provider: providerCode, providerEnvelopeId: ev.providerEnvelopeId }, transaction: u.tx });
    if (!env) throw new NotFoundError("Envelope");
    const id = env.get("id");
    if (["completed", "declined", "cancelled", "expired"].includes(env.get("status"))) { await sigEvent(u, id, `ignored.${ev.type}`, { reason: `envelope is ${env.get("status")}` }); return "ignored"; }
    if (env.get("status") !== "sent") throw new ConflictError("The envelope has not been sent");

    if (ev.type === "envelope.cancelled") {
      await u.repo("SignatureEnvelope").updateById(id, { status: "cancelled" }, { transaction: u.tx });
      await sigEvent(u, id, "envelope.cancelled", { by: "provider" });
      return "applied";
    }
    const signers = (await u.repo("SignatureSigner").findAll({ where: { envelopeId: id }, order: [["signOrder", "ASC"]], transaction: u.tx })) as any[];
    const signer = signers.find((s) => s.get("email") === normalizeEmail(ev.signerEmail));
    if (!signer) throw new ConflictError("Unknown signer");

    if (ev.type === "signer.declined") {
      await u.repo("SignatureSigner").updateById(signer.get("id"), { status: "declined" }, { transaction: u.tx });
      await u.repo("SignatureEnvelope").updateById(id, { status: "declined" }, { transaction: u.tx });
      await sigEvent(u, id, "signer.declined", { email: signer.get("email") });
      await u.emit({ type: "signature.declined", aggregateType: "signature_envelope", aggregateId: id, payload: { dealId: env.get("dealId") } });
      return "declined";
    }

    if (signer.get("status") === "signed") { await sigEvent(u, id, "ignored.signer.signed", { reason: "already signed" }); return "ignored"; }
    if (signers.some((s) => s.get("signOrder") < signer.get("signOrder") && s.get("status") !== "signed")) throw new ConflictError("Signers must sign in order");

    const signedAt = new Date(ev.occurredAt);
    await u.repo("SignatureSigner").updateById(signer.get("id"), {
      status: "signed", signedAt, signerIp: ev.ip ?? null, certificate: { method: "provider-callback", provider: providerCode, eventId: ev.eventId, contentHash: env.get("contentHash") },
    }, { transaction: u.tx });
    await sigEvent(u, id, "signer.signed", { email: signer.get("email"), signedAt: signedAt.toISOString(), ip: ev.ip ?? null });

    const remaining = signers.filter((s) => s.get("id") !== signer.get("id") && s.get("status") !== "signed");
    if (remaining.length) return "applied";

    // Everyone has signed: prove the document is still exactly what was sent before we call it complete.
    let loaded;
    try { loaded = await loadVersionBytes(u, env.get("documentId"), env.get("documentVersion")); } catch { loaded = null; }
    if (!loaded || loaded.hash !== env.get("contentHash")) {
      await sigEvent(u, id, "integrity.failed", { expected: env.get("contentHash") });
      await u.audit({ action: "signature.integrity_failure", entityType: "signature_envelope", entityId: id, after: { expected: env.get("contentHash") } });
      return "tamper_detected";
    }
    const evidence: SignatureEvidence = {
      provider: providerCode, providerEnvelopeId: ev.providerEnvelopeId, contentHash: env.get("contentHash"), completedAt: new Date().toISOString(),
      signers: signers.map((s) => ({ name: s.get("name"), email: s.get("email"), signedAt: (s.get("id") === signer.get("id") ? signedAt : new Date(s.get("signedAt"))).toISOString(), ip: s.get("id") === signer.get("id") ? ev.ip ?? null : s.get("signerIp") })),
    };
    await u.repo("SignatureEnvelope").updateById(id, { status: "completed", completedAt: new Date(), evidence }, { transaction: u.tx });
    await sigEvent(u, id, "envelope.completed", { contentHash: evidence.contentHash });
    if (env.get("dealId")) await completeMilestoneInUow(u, env.get("dealId"), "contract_signed", `signature:${id}`, { envelopeId: id });
    await u.audit({ action: "signature.completed", entityType: "signature_envelope", entityId: id, after: { contentHash: evidence.contentHash, signers: evidence.signers.length } });
    await u.emit({ type: "signature.completed", aggregateType: "signature_envelope", aggregateId: id, payload: { dealId: env.get("dealId"), contentHash: evidence.contentHash } });
    return "completed";
  });
}
