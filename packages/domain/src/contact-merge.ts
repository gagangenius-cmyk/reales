import { QueryTypes } from "sequelize";
import type { Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { requireStepUp } from "@reales/auth";
import { ForbiddenError } from "@reales/rbac";
import { ConflictError, NotFoundError, withUow } from "./uow";

/**
 * Merge a duplicate contact into the one to keep. Everything that points at the duplicate (leads, calls, viewings, offers, deals, invoices, messages,
 * documents, notes...) is moved to the survivor, empty fields on the survivor are filled from the duplicate, and the duplicate is archived and put in the
 * Trash (restorable). Rules that protect people and the company:
 *  - tenant-wide access and a recent step-up confirmation are required, and every merge is audited with the counts moved;
 *  - consent is personal: consent records and their history stay with the duplicate and are NOT copied to the survivor, so a merge can never make
 *    someone contactable who has not agreed (suppressions, which only restrict, do move);
 *  - a contact under a legal hold, with a KYC profile, or with a privacy request open or closed is refused, because those records must stay attached to
 *    the identity they were made for; resolve them first.
 * The table list is read from the database, so a table added later is merged too without anyone remembering to update this file. A row that would break a
 * unique rule on the survivor stays with the duplicate (kept, not lost) and is counted as "left behind".
 */
const NOT_MOVED = new Set(["contacts", "consent_records", "consent_events", "kyc_profiles", "dsr_requests", "legal_holds"]);
const FILL = ["first_name", "last_name", "company_name", "email", "normalized_email", "phone_e164", "language", "nationality", "salutation", "gender", "date_of_birth", "job_title", "employer", "phone_secondary", "whatsapp_e164", "address_line", "city", "country", "residency", "preferred_channel", "preferred_contact_time", "owner_user_id", "branch_id", "organization_id"];

export interface MergeResult { survivorId: string; mergedId: string; moved: Record<string, number>; leftBehind: Record<string, number>; filled: string[] }

const tenantWide = (ctx: RequestContext) => { if (!ctx.grants.some((g) => g.permission === "contact.update" && g.scope === "tenant")) throw new ForbiddenError("Merging contacts needs tenant-wide contact access"); };

export async function mergeContacts(sq: Sequelize, ctx: RequestContext, i: { survivorId: string; duplicateId: string }): Promise<MergeResult> {
  tenantWide(ctx);
  requireStepUp(ctx);
  if (i.survivorId === i.duplicateId) throw new ConflictError("Choose two different contacts");
  return withUow(sq, ctx, async (u) => {
    const q = async (sql: string, r: Record<string, unknown> = {}) => (await u.sq.query(sql, { replacements: { t: ctx.tenantId, ...r }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    const rows = await q("SELECT * FROM contacts WHERE tenant_id=:t AND id IN (:a,:b) AND deleted_at IS NULL FOR UPDATE", { a: i.survivorId, b: i.duplicateId });
    const keep = rows.find((r) => r.id === i.survivorId), dup = rows.find((r) => r.id === i.duplicateId);
    if (!keep || !dup) throw new NotFoundError("Contact");
    for (const [t, why] of [["legal_holds", "a legal hold"], ["kyc_profiles", "a KYC profile"], ["dsr_requests", "a privacy request"]] as const) {
      const [n] = await q(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id=:t AND contact_id IN (:a,:b)`, { a: i.survivorId, b: i.duplicateId });
      if (Number(n.n) > 0) throw new ConflictError(`One of these contacts has ${why}. Those records must stay with the person they were made for, so these contacts cannot be merged.`);
    }

    const filled: string[] = [];
    const patch: string[] = [];
    for (const c of FILL) if ((keep[c] === null || keep[c] === "") && dup[c] !== null && dup[c] !== "") { patch.push(`${c}=:v_${c}`); filled.push(c); }
    if (patch.length) await u.sq.query(`UPDATE contacts SET ${patch.join(", ")} WHERE tenant_id=:t AND id=:k`, { replacements: { t: ctx.tenantId, k: i.survivorId, ...Object.fromEntries(filled.map((c) => [`v_${c}`, dup[c]])) }, transaction: u.tx });

    const tables = (await q("SELECT DISTINCT c.table_name AS name FROM information_schema.columns c JOIN information_schema.columns t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.column_name='tenant_id' WHERE c.table_schema=DATABASE() AND c.column_name='contact_id' ORDER BY 1")).map((r) => String(r.name ?? r.NAME ?? r.table_name)).filter((n) => !NOT_MOVED.has(n) && /^[a-z0-9_]+$/.test(n));
    const moved: Record<string, number> = {}, leftBehind: Record<string, number> = {};
    for (const t of tables) {
      const [res]: any = await u.sq.query(`UPDATE IGNORE ${t} SET contact_id=:k WHERE tenant_id=:t AND contact_id=:d`, { replacements: { t: ctx.tenantId, k: i.survivorId, d: i.duplicateId }, transaction: u.tx });
      const n = Number(res?.affectedRows ?? res ?? 0);
      if (n) moved[t] = n;
      const [left] = await q(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id=:t AND contact_id=:d`, { d: i.duplicateId });
      if (Number(left.n)) leftBehind[t] = Number(left.n);
    }
    // timeline entries written against the contact itself
    const [act]: any = await u.sq.query("UPDATE activities SET entity_id=:k WHERE tenant_id=:t AND entity_type='contact' AND entity_id=:d", { replacements: { t: ctx.tenantId, k: i.survivorId, d: i.duplicateId }, transaction: u.tx });
    if (Number(act?.affectedRows ?? 0)) moved.activities = Number(act.affectedRows);

    await u.sq.query("UPDATE contacts SET status='archived', deleted_at=NOW(3), deleted_by=:u WHERE tenant_id=:t AND id=:d", { replacements: { t: ctx.tenantId, u: ctx.userId, d: i.duplicateId }, transaction: u.tx });
    const name = [dup.first_name, dup.last_name].filter(Boolean).join(" ") || dup.company_name || dup.email || dup.phone_e164 || "a duplicate";
    await u.repo("Activity").create({ entityType: "contact", entityId: i.survivorId, kind: "system", summary: `Merged ${name} into this contact`.slice(0, 4000), actorId: ctx.userId, occurredAt: new Date(), createdAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "contact.merged", entityType: "contacts", entityId: i.survivorId, before: { duplicateId: i.duplicateId }, after: { moved, leftBehind, filled } });
    await u.emit({ type: "contact.merged", aggregateType: "contact", aggregateId: i.survivorId, projectId: null, payload: { duplicateId: i.duplicateId } });
    return { survivorId: i.survivorId, mergedId: i.duplicateId, moved, leftBehind, filled };
  });
}

/** Possible duplicates of one contact (same email, phone or WhatsApp number), for the "Merge" screen. */
export async function duplicateCandidates(sq: Sequelize, ctx: RequestContext, contactId: string) {
  tenantWide(ctx);
  return withUow(sq, ctx, async (u) => {
    const q = async (sql: string, r: Record<string, unknown> = {}) => (await u.sq.query(sql, { replacements: { t: ctx.tenantId, ...r }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    const [c] = await q("SELECT id, normalized_email, phone_e164, whatsapp_e164 FROM contacts WHERE tenant_id=:t AND id=:id AND deleted_at IS NULL", { id: contactId });
    if (!c) throw new NotFoundError("Contact");
    const phones = [c.phone_e164, c.whatsapp_e164].filter(Boolean);
    if (!c.normalized_email && !phones.length) return [];
    const rows = await q(`SELECT id, first_name, last_name, company_name, email, phone_e164, created_at FROM contacts WHERE tenant_id=:t AND deleted_at IS NULL AND id<>:id AND (${[c.normalized_email ? "normalized_email=:e" : "0", phones.length ? "phone_e164 IN (:p) OR whatsapp_e164 IN (:p)" : "0"].join(" OR ")}) ORDER BY created_at LIMIT 20`, { id: contactId, e: c.normalized_email ?? "", p: phones.length ? phones : [""] });
    return rows.map((r) => ({ id: r.id as string, name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.company_name || r.email || r.phone_e164 || "Unnamed", email: r.email as string | null, phone: r.phone_e164 as string | null, createdAt: r.created_at }));
  });
}
