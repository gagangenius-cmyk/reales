import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, systemContext, type RequestContext } from "@reales/database";
import { decryptField, encryptField } from "@reales/auth";
import { authorize } from "@reales/rbac";
import { ingestLead } from "./leads";
import { plain } from "./scope";
import { WebhookSignatureError } from "./providers";
import { ConflictError, NotFoundError, withUow } from "./uow";

export type IngestKind = "meta" | "portal" | "website" | "generic";
export interface SourceInput { name: string; kind: IngestKind; sourceCode?: string | null; projectId?: string | null; poolId?: string | null; routeMode?: "rules" | "pool"; defaultPurpose?: "buy" | "rent" | "invest" | "off_plan"; campaign?: string | null }

const newSecret = () => randomBytes(24).toString("base64url");
const newPublicId = () => randomBytes(15).toString("base64url");

/** Create an inbound endpoint. The signing secret is returned ONCE here and stored encrypted; it cannot be read back later (rotate to get a new one). */
export async function createIngestSource(sq: Sequelize, ctx: RequestContext, i: SourceInput) {
  authorize(ctx, "leadsource.manage");
  if (!i.name.trim()) throw new ConflictError("Give the source a name");
  if (i.routeMode === "pool" && !i.poolId) throw new ConflictError("Choose the pool new leads should go to");
  return withUow(sq, ctx, async (u) => {
    if (i.poolId && !(await u.repo("LeadPool").findById(i.poolId, { transaction: u.tx }))) throw new NotFoundError("Pool");
    if (i.projectId && !(await u.repo("Project").findById(i.projectId, { transaction: u.tx }))) throw new NotFoundError("Project");
    if (i.sourceCode && !(await u.repo("LeadSource").findOne({ where: { code: i.sourceCode }, transaction: u.tx }))) throw new NotFoundError("Lead source");
    const id = randomUUID(), publicId = newPublicId(), secret = newSecret();
    await u.repo("LeadIngestSource").create({ id, name: i.name.trim(), kind: i.kind, publicId, secretEnc: encryptField(secret), sourceCode: i.sourceCode ?? null, projectId: i.projectId ?? null, poolId: i.poolId ?? null, routeMode: i.routeMode ?? "rules", defaultPurpose: i.defaultPurpose ?? "buy", campaign: i.campaign?.trim() || null, active: true, createdBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: "lead_source.created", entityType: "lead_ingest_source", entityId: id, after: { name: i.name, kind: i.kind } });
    return { id, publicId, secret };
  });
}

export async function rotateIngestSecret(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "leadsource.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("LeadIngestSource").findById(id, { transaction: u.tx }))) throw new NotFoundError("Source");
    const secret = newSecret();
    await u.repo("LeadIngestSource").updateById(id, { secretEnc: encryptField(secret) }, { transaction: u.tx });
    await u.audit({ action: "lead_source.secret_rotated", entityType: "lead_ingest_source", entityId: id });
    return { secret };
  });
}

export async function setIngestSourceActive(sq: Sequelize, ctx: RequestContext, id: string, active: boolean) {
  authorize(ctx, "leadsource.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("LeadIngestSource").findById(id, { transaction: u.tx }))) throw new NotFoundError("Source");
    await u.repo("LeadIngestSource").updateById(id, { active }, { transaction: u.tx });
    await u.audit({ action: active ? "lead_source.enabled" : "lead_source.disabled", entityType: "lead_ingest_source", entityId: id });
  });
}

export async function listIngestSources(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "leadsource.manage");
  return withUow(sq, ctx, async (u) => {
    const sources = (await u.repo("LeadIngestSource").findAll({ order: [["createdAt", "DESC"]], transaction: u.tx })) as any[];
    const recent = (await u.repo("LeadIngestEvent").findAll({ order: [["receivedAt", "DESC"]], limit: 40, transaction: u.tx })) as any[];
    return {
      sources: sources.map((s) => { const { secretEnc: _s, ...rest } = plain(s); return rest; }),
      events: recent.map(plain),
    };
  });
}

// ------------------------------------------------------------------ payload mapping
export interface NormalizedLead { externalId: string; firstName?: string; lastName?: string; email?: string; phone?: string; purpose?: "buy" | "rent" | "invest" | "off_plan"; notes?: string; campaign?: string; language?: string; budgetMax?: number }

const pick = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) { const v = o[k]; if (typeof v === "string" && v.trim()) return v.trim(); if (typeof v === "number") return String(v); } return undefined; };
const PURPOSES: Record<string, NormalizedLead["purpose"]> = { buy: "buy", purchase: "buy", sale: "buy", rent: "rent", rental: "rent", lease: "rent", invest: "invest", investment: "invest", off_plan: "off_plan", "off-plan": "off_plan", offplan: "off_plan" };

/** Accepts flat JSON, Meta-style `field_data: [{ name, values }]`, or `{ leads: [...] }` / `{ entry: [...] }` batches. Unknown fields end up in the notes. */
export function normalizeLeadPayload(body: unknown): NormalizedLead[] {
  const out: NormalizedLead[] = [];
  const one = (raw: Record<string, unknown>) => {
    const flat: Record<string, unknown> = { ...raw };
    if (Array.isArray(raw.field_data)) for (const f of raw.field_data as { name?: string; values?: unknown[] }[]) if (f?.name && Array.isArray(f.values) && f.values.length) flat[String(f.name).toLowerCase()] = f.values[0];
    const full = pick(flat, ["full_name", "name", "fullname", "customer_name"]);
    const first = pick(flat, ["first_name", "firstname", "given_name"]) ?? full?.split(/\s+/)[0];
    const last = pick(flat, ["last_name", "lastname", "surname", "family_name"]) ?? (full && full.includes(" ") ? full.split(/\s+/).slice(1).join(" ") : undefined);
    const email = pick(flat, ["email", "email_address", "e-mail"]);
    const phone = pick(flat, ["phone", "phone_number", "mobile", "mobile_number", "whatsapp", "contact_number", "telephone"]);
    const rawPurpose = pick(flat, ["purpose", "intent", "looking_to", "enquiry_type"])?.toLowerCase().replace(/\s+/g, "_");
    const used = new Set(["full_name", "name", "fullname", "customer_name", "first_name", "firstname", "given_name", "last_name", "lastname", "surname", "family_name", "email", "email_address", "e-mail", "phone", "phone_number", "mobile", "mobile_number", "whatsapp", "contact_number", "telephone", "purpose", "intent", "looking_to", "enquiry_type", "field_data", "id", "lead_id", "leadgen_id", "external_id", "reference", "campaign", "campaign_name", "language", "budget", "message", "comments", "notes"]);
    const extras = Object.entries(flat).filter(([k, v]) => !used.has(k) && (typeof v === "string" || typeof v === "number") && String(v).trim()).slice(0, 12).map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`);
    const message = pick(flat, ["message", "comments", "notes"]);
    const budgetRaw = pick(flat, ["budget", "max_budget", "price"]);
    const budget = budgetRaw ? Number(budgetRaw.replace(/[^\d.]/g, "")) : NaN;
    const ext = pick(flat, ["id", "lead_id", "leadgen_id", "external_id", "reference"]) ?? `h_${createHash("sha256").update(JSON.stringify([email ?? "", phone ?? "", first ?? "", message ?? "", pick(flat, ["created_time", "timestamp", "created_at"]) ?? ""])).digest("hex").slice(0, 40)}`;
    out.push({
      externalId: ext.slice(0, 160), firstName: first?.slice(0, 120), lastName: last?.slice(0, 120), email: email?.slice(0, 254), phone: phone?.slice(0, 40), purpose: rawPurpose ? PURPOSES[rawPurpose] : undefined,
      notes: [message, ...extras].filter(Boolean).join("\n").slice(0, 4000) || undefined, campaign: pick(flat, ["campaign", "campaign_name"])?.slice(0, 160), language: pick(flat, ["language"])?.slice(0, 10),
      budgetMax: Number.isFinite(budget) && budget > 0 ? budget : undefined,
    });
  };
  const b = body as Record<string, any> | null;
  if (!b || typeof b !== "object") return out;
  if (Array.isArray(b.leads)) {
    b.leads.slice(0, 100).forEach((x: any) => { if (x && typeof x === "object") one(x); });
  } else if (Array.isArray(b.entry)) {
    for (const e of b.entry.slice(0, 50)) for (const c of e?.changes ?? []) { if (c?.value && typeof c.value === "object") one(c.value); }
  } else {
    one(b);
  }
  return out;
}

// ------------------------------------------------------------------ receiving
export interface ReceiveResult { received: number; created: number; duplicate: number; rejected: number }

const validSig = (secret: string, raw: string, header: string | null | undefined) => {
  if (!header) return false;
  const given = header.replace(/^sha256=/i, "").trim().toLowerCase();
  const want = createHmac("sha256", secret).update(raw).digest("hex");
  return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
};

/** Meta's endpoint verification handshake: echoes hub.challenge when hub.verify_token equals the source secret. */
export async function verifyIngestHandshake(sq: Sequelize, publicId: string, token: string | null): Promise<boolean> {
  const [row] = await sq.query<{ secret_enc: string }>("SELECT secret_enc FROM lead_ingest_sources WHERE public_id=:p AND active=1", { replacements: { p: publicId }, type: QueryTypes.SELECT });
  if (!row || !token) return false;
  const secret = decryptField(row.secret_enc);
  return secret.length === token.length && timingSafeEqual(Buffer.from(secret), Buffer.from(token));
}

/**
 * Public front door for one source: verify the HMAC over the RAW body, then create or de-duplicate each lead. A bad signature throws
 * WebhookSignatureError and stores nothing; a malformed lead is recorded as rejected without failing the rest of the batch.
 */
export async function receiveIngestedLeads(sq: Sequelize, o: { publicId: string; rawBody: string; headers: Record<string, string | null | undefined> }): Promise<ReceiveResult> {
  const [src] = await sq.query<any>("SELECT * FROM lead_ingest_sources WHERE public_id=:p", { replacements: { p: o.publicId }, type: QueryTypes.SELECT });
  // Same answer for "no such source" and "bad signature": the endpoint does not reveal which public ids exist.
  if (!src || !src.active) throw new WebhookSignatureError();
  const secret = decryptField(src.secret_enc);
  if (!validSig(secret, o.rawBody, o.headers["x-signature"] ?? o.headers["x-hub-signature-256"])) throw new WebhookSignatureError();
  let body: unknown;
  try { body = JSON.parse(o.rawBody); } catch { throw new ConflictError("Body must be JSON"); }
  const items = normalizeLeadPayload(body);
  if (!items.length) throw new ConflictError("No leads found in the payload");
  const result: ReceiveResult = { received: items.length, created: 0, duplicate: 0, rejected: 0 };
  const ctx = systemContext(src.tenant_id, `corr_ingest_${randomUUID()}`);
  for (const it of items) {
    const record = (status: "created" | "duplicate" | "rejected", leadId: string | null, error: string | null) =>
      sq.query("INSERT INTO lead_ingest_events (id, tenant_id, source_id, external_id, status, lead_id, error, received_at, created_at, updated_at) VALUES (:id,:t,:s,:x,:st,:l,:e,:r,NOW(3),NOW(3)) ON DUPLICATE KEY UPDATE status=VALUES(status), lead_id=VALUES(lead_id), error=VALUES(error), updated_at=NOW(3)",
        { replacements: { id: randomUUID(), t: src.tenant_id, s: src.id, x: it.externalId, st: status, l: leadId, e: error?.slice(0, 255) ?? null, r: mysqlDate(new Date()) } });
    const seen = await sq.query<{ status: string }>("SELECT status FROM lead_ingest_events WHERE tenant_id=:t AND source_id=:s AND external_id=:x", { replacements: { t: src.tenant_id, s: src.id, x: it.externalId }, type: QueryTypes.SELECT });
    if (seen.length && seen[0]!.status !== "rejected") { result.duplicate++; continue; }
    try {
      if (!it.firstName && !it.lastName && !it.email && !it.phone) throw new ConflictError("The lead has no name, email or phone");
      const r = await ingestLead(sq, src.tenant_id, {
        contact: { firstName: it.firstName, lastName: it.lastName, email: it.email, phone: it.phone, language: it.language },
        purpose: it.purpose ?? src.default_purpose, sourceCode: src.source_code ?? undefined, projectId: src.project_id ?? undefined, campaign: it.campaign ?? src.campaign ?? undefined, notes: it.notes, budgetMax: it.budgetMax,
      });
      if (src.route_mode === "pool" && src.pool_id && !r.duplicate) {
        await withUow(sq, ctx, async (u) => {
          await u.repo("Lead").updateById(r.lead.id, { assignedUserId: null, poolId: src.pool_id, pooledAt: new Date() }, { transaction: u.tx });
          await u.repo("LeadAssignment").create({ id: randomUUID(), leadId: r.lead.id, assignedUserId: null, previousUserId: r.assignedUserId, ruleId: null, method: "rule", reason: `Inbound source ${src.name}: sent to pool`, actorId: null, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
        });
      }
      await record(r.duplicate ? "duplicate" : "created", r.lead.id, null);
      if (r.duplicate) result.duplicate++; else result.created++;
    } catch (e) {
      await record("rejected", null, e instanceof Error ? e.message : "Rejected");
      result.rejected++;
    }
  }
  await sq.query("UPDATE lead_ingest_sources SET total_received = total_received + :n, last_received_at = NOW(3) WHERE id=:id AND tenant_id=:t", { replacements: { n: result.created, id: src.id, t: src.tenant_id } });
  return result;
}
