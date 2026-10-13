import { createHash, randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { mysqlDate } from "@reales/database";
import { requireStepUp } from "@reales/auth";
import { authorize, can, hasPermission, ForbiddenError } from "@reales/rbac";
import { normalizeEmail, normalizePhone } from "./normalize";
import { plain } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

export const CHANNELS = ["whatsapp", "sms", "email", "call"] as const;
export type Channel = (typeof CHANNELS)[number];

export const DEFAULT_PURPOSES = [
  { code: "marketing", name: "Marketing and property recommendations", defaultBasis: "consent" },
  { code: "service", name: "Service messages about an active enquiry or transaction", defaultBasis: "contract" },
] as const;

export async function ensureDefaultConsentPurposes(sq: Sequelize, tenantId: string) {
  for (const p of DEFAULT_PURPOSES) {
    await sq.query(
      "INSERT INTO consent_purposes (id, tenant_id, code, name, default_basis, created_at, updated_at) VALUES (UUID(), :t, :code, :name, :basis, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE name=VALUES(name)",
      { replacements: { t: tenantId, code: p.code, name: p.name, basis: p.defaultBasis } },
    );
  }
}

export interface RecordConsentInput {
  contactId: string;
  purposeCode: string;
  channel: Channel;
  granted: boolean;
  basis?: "consent" | "contract" | "legitimate_interest" | "legal_obligation";
  /** Version label and the exact text shown to the person; only the hash of the text is stored with the event. */
  textVersion?: string;
  text?: string;
  source?: string;
  ip?: string | null;
  userAgent?: string | null;
  /** On revocation, also add the destination to the suppression list (e.g. a STOP reply). */
  suppress?: boolean;
}

/**
 * Consent is purpose- and channel-specific, with an immutable event history (consent_events) and a current-state
 * projection (consent_records). Recording is allowed for consent.manage holders or anyone who may update the contact.
 */
export async function recordConsent(sq: Sequelize, ctx: RequestContext, input: RecordConsentInput) {
  return withUow(sq, ctx, async (u) => {
    const contact: any = await u.repo("Contact").findById(input.contactId, { transaction: u.tx });
    if (!contact) throw new NotFoundError("Contact");
    if (ctx.userId !== "system" && !can(ctx, "consent.manage") && !can(ctx, "contact.update", { ownerUserId: contact.get("ownerUserId"), branchId: contact.get("branchId") })) {
      throw new ForbiddenError("Missing permission: consent.manage");
    }
    const purpose: any = await u.repo("ConsentPurpose").findOne({ where: { code: input.purposeCode }, transaction: u.tx });
    if (!purpose) throw new NotFoundError("Consent purpose");
    const basis = input.basis ?? purpose.get("defaultBasis");
    const now = new Date();
    let rec: any = await u.repo("ConsentRecord").findOne({ where: { contactId: input.contactId, purposeId: purpose.get("id"), channel: input.channel }, transaction: u.tx });
    const status = input.granted ? "granted" : "revoked";
    if (!rec) {
      rec = await u.repo("ConsentRecord").create({
        id: randomUUID(), contactId: input.contactId, purposeId: purpose.get("id"), channel: input.channel, status, basis,
        textVersion: input.textVersion ?? null, source: input.source ?? null,
        grantedAt: input.granted ? now : null, revokedAt: input.granted ? null : now,
      }, { transaction: u.tx });
    } else {
      await u.repo("ConsentRecord").updateById(rec.get("id"), {
        status, basis, textVersion: input.textVersion ?? rec.get("textVersion"), source: input.source ?? rec.get("source"),
        grantedAt: input.granted ? now : rec.get("grantedAt"), revokedAt: input.granted ? null : now,
      }, { transaction: u.tx });
    }
    await u.sq.query(
      `INSERT INTO consent_events (id, tenant_id, consent_record_id, contact_id, purpose_id, channel, event, basis, text_version, text_hash, source, ip, user_agent, actor_id, created_at)
       VALUES (UUID(), :t, :rid, :cid, :pid, :ch, :ev, :basis, :tv, :th, :src, :ip, :ua, :actor, :now)`,
      {
        transaction: u.tx,
        replacements: {
          t: ctx.tenantId, rid: rec.get("id"), cid: input.contactId, pid: purpose.get("id"), ch: input.channel, ev: status, basis,
          tv: input.textVersion ?? null, th: input.text ? createHash("sha256").update(input.text).digest("hex") : null, src: input.source ?? null,
          ip: input.ip ?? ctx.ip ?? null, ua: (input.userAgent ?? ctx.userAgent)?.slice(0, 255) ?? null, actor: ctx.userId === "system" ? null : ctx.userId,
          now: mysqlDate(now),
        },
      },
    );
    if (!input.granted && input.suppress) {
      const dest = destinationFor(contact, input.channel);
      if (dest) await addSuppressionInUow(u, ctx, { channel: input.channel, destination: dest, reason: "unsubscribed", contactId: input.contactId });
    }
    await u.emit({ type: input.granted ? "consent.granted" : "consent.revoked", aggregateType: "contact", aggregateId: input.contactId, payload: { purpose: input.purposeCode, channel: input.channel } });
    return plain(await u.repo("ConsentRecord").findById(rec.get("id"), { transaction: u.tx }));
  });
}

export function destinationFor(contact: any, channel: Channel): string | null {
  return channel === "email" ? contact.get("normalizedEmail") : contact.get("phoneE164");
}

async function addSuppressionInUow(u: any, ctx: RequestContext, i: { channel: Channel; destination: string; reason: string; contactId?: string | null }) {
  const dest = i.channel === "email" ? normalizeEmail(i.destination) : normalizePhone(i.destination);
  if (!dest) throw new ConflictError("Invalid destination for suppression");
  const existing = await u.repo("SuppressionEntry").findOne({ where: { channel: i.channel, destination: dest }, transaction: u.tx });
  if (existing) return plain(existing);
  const row = await u.repo("SuppressionEntry").create({ id: randomUUID(), channel: i.channel, destination: dest, reason: i.reason, contactId: i.contactId ?? null, createdBy: ctx.userId === "system" ? null : ctx.userId }, { transaction: u.tx });
  await u.emit({ type: "suppression.added", aggregateType: "suppression", aggregateId: row.get("id"), payload: { channel: i.channel, reason: i.reason } });
  return plain(row);
}

export async function addSuppression(sq: Sequelize, ctx: RequestContext, i: { channel: Channel; destination: string; reason: "unsubscribed" | "complaint" | "dnd" | "bounced" | "manual" | "legal"; contactId?: string }) {
  authorize(ctx, "consent.manage");
  return withUow(sq, ctx, async (u) => addSuppressionInUow(u, ctx, i));
}

/** Lifting a suppression can re-expose a person who complained or opted out, so it needs step-up, a reason and an audit trail. */
export async function liftSuppression(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  authorize(ctx, "consent.manage");
  requireStepUp(ctx);
  if (reason.trim().length < 10) throw new ConflictError("A reason of at least 10 characters is required");
  return withUow(sq, ctx, async (u) => {
    const s: any = await u.repo("SuppressionEntry").findById(id, { transaction: u.tx });
    if (!s) throw new NotFoundError("Suppression entry");
    await u.repo("SuppressionEntry").deleteById(id, { transaction: u.tx });
    await u.audit({ action: "suppression.lifted", entityType: "suppression", entityId: id, before: { channel: s.get("channel"), destination: s.get("destination"), reason: s.get("reason") }, reason });
    await u.emit({ type: "suppression.lifted", aggregateType: "suppression", aggregateId: id, payload: { channel: s.get("channel") } });
  });
}

export interface Contactability { allowed: boolean; reasons: string[]; destination: string | null }

/**
 * The single gate every outbound message must pass (broadcasts, workflows, bots, manual sends):
 * a usable destination, no suppression entry, and - when the purpose relies on consent - a granted consent record.
 */
export async function evaluateContactability(
  sq: Sequelize, tenantId: string, i: { contactId: string; channel: Channel; purposeCode: string },
): Promise<Contactability> {
  const [c] = await sq.query<{ normalized_email: string | null; phone_e164: string | null; status: string }>(
    "SELECT normalized_email, phone_e164, status FROM contacts WHERE tenant_id=:t AND id=:id", { replacements: { t: tenantId, id: i.contactId }, type: QueryTypes.SELECT });
  if (!c) return { allowed: false, reasons: ["contact_not_found"], destination: null };
  const destination = i.channel === "email" ? c.normalized_email : c.phone_e164;
  const reasons: string[] = [];
  if (c.status !== "active") reasons.push("contact_archived");
  if (!destination) reasons.push("no_destination");
  if (destination) {
    const [s] = await sq.query<{ reason: string }>("SELECT reason FROM suppression_entries WHERE tenant_id=:t AND channel=:ch AND destination=:d", { replacements: { t: tenantId, ch: i.channel, d: destination }, type: QueryTypes.SELECT });
    if (s) reasons.push(`suppressed:${s.reason}`);
  }
  const [p] = await sq.query<{ id: string; default_basis: string }>("SELECT id, default_basis FROM consent_purposes WHERE tenant_id=:t AND code=:code", { replacements: { t: tenantId, code: i.purposeCode }, type: QueryTypes.SELECT });
  if (!p) reasons.push("unknown_purpose");
  else if (p.default_basis === "consent") {
    const [r] = await sq.query<{ status: string }>("SELECT status FROM consent_records WHERE tenant_id=:t AND contact_id=:c AND purpose_id=:p AND channel=:ch", { replacements: { t: tenantId, c: i.contactId, p: p.id, ch: i.channel }, type: QueryTypes.SELECT });
    if (r?.status !== "granted") reasons.push("no_consent");
  }
  return { allowed: reasons.length === 0, reasons, destination: destination ?? null };
}

export async function listConsent(sq: Sequelize, ctx: RequestContext, contactId: string) {
  if (!hasPermission(ctx, "contact.read") && !hasPermission(ctx, "consent.manage")) throw new ForbiddenError("Missing permission: contact.read");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Contact").findById(contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    const records = await u.repo("ConsentRecord").findAll({ where: { contactId }, transaction: u.tx });
    const events = await u.repo("ConsentEvent").findAll({ where: { contactId }, order: [["createdAt", "DESC"]], limit: 100, transaction: u.tx });
    return { records: records.map(plain), events: events.map(plain) };
  });
}
