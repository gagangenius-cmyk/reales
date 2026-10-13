import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, RequestContext, systemContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { evaluateContactability } from "./consent";
import { MissingVariableError, MessageChannel } from "./templating";
import { sendMessage } from "./messaging";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

// ---------------------------------------------------------------- segments (declarative, never raw SQL)
export interface SegmentDefinition {
  language?: string[]; nationality?: string[]; branchId?: string; ownerUserId?: string;
  hasOpenLead?: boolean; leadPurpose?: Array<"buy" | "rent" | "invest" | "off_plan">; leadProjectIds?: string[];
  budgetMin?: number; budgetMax?: number; createdAfter?: string; createdBefore?: string;
}
const KEYS = new Set(["language", "nationality", "branchId", "ownerUserId", "hasOpenLead", "leadPurpose", "leadProjectIds", "budgetMin", "budgetMax", "createdAfter", "createdBefore"]);

export function validateSegment(def: unknown): SegmentDefinition {
  if (!def || typeof def !== "object" || Array.isArray(def)) throw new ConflictError("A segment definition must be an object");
  for (const k of Object.keys(def)) if (!KEYS.has(k)) throw new ConflictError(`Unknown segment filter "${k}"`);
  return def as SegmentDefinition;
}

async function resolveSegmentContacts(u: Uow, def: SegmentDefinition): Promise<any[]> {
  const and: WhereOptions[] = [{ status: "active" }];
  if (def.language?.length) and.push({ language: { [Op.in]: def.language } });
  if (def.nationality?.length) and.push({ nationality: { [Op.in]: def.nationality } });
  if (def.branchId) and.push({ branchId: def.branchId });
  if (def.ownerUserId) and.push({ ownerUserId: def.ownerUserId });
  if (def.createdAfter) and.push({ createdAt: { [Op.gte]: new Date(def.createdAfter) } });
  if (def.createdBefore) and.push({ createdAt: { [Op.lt]: new Date(def.createdBefore) } });
  const leadFilter = def.hasOpenLead !== undefined || def.leadPurpose?.length || def.leadProjectIds?.length || def.budgetMin !== undefined || def.budgetMax !== undefined;
  if (leadFilter) {
    const lw: WhereOptions[] = [];
    if (def.hasOpenLead !== false) lw.push({ status: "open" });
    if (def.leadPurpose?.length) lw.push({ purpose: { [Op.in]: def.leadPurpose } });
    if (def.leadProjectIds?.length) lw.push({ projectId: { [Op.in]: def.leadProjectIds } });
    if (def.budgetMin !== undefined) lw.push({ budgetMax: { [Op.gte]: def.budgetMin } });
    if (def.budgetMax !== undefined) lw.push({ budgetMin: { [Op.lte]: def.budgetMax } });
    const leads = await u.repo("Lead").findAll({ where: { [Op.and]: lw }, attributes: ["contactId"], transaction: u.tx });
    const ids = [...new Set((leads as any[]).map((l) => l.get("contactId") as string))];
    if (def.hasOpenLead === false) and.push({ id: { [Op.notIn]: ids.length ? ids : ["-"] } });
    else and.push({ id: { [Op.in]: ids.length ? ids : ["-"] } });
  }
  return u.repo("Contact").findAll({ where: { [Op.and]: and }, order: [["createdAt", "ASC"], ["id", "ASC"]], transaction: u.tx });
}

export async function createSegment(sq: Sequelize, ctx: RequestContext, i: { name: string; definition: SegmentDefinition }) {
  authorize(ctx, "segment.manage");
  const definition = validateSegment(i.definition);
  return withUow(sq, ctx, async (u) => {
    if (await u.repo("Segment").findOne({ where: { name: i.name }, transaction: u.tx })) throw new ConflictError("A segment with this name already exists");
    return plain(await u.repo("Segment").create({ id: randomUUID(), name: i.name, definition, createdBy: ctx.userId }, { transaction: u.tx }));
  });
}

export async function previewSegment(sq: Sequelize, ctx: RequestContext, def: SegmentDefinition) {
  authorize(ctx, "segment.manage");
  return withUow(sq, ctx, async (u) => ({ count: (await resolveSegmentContacts(u, validateSegment(def))).length }));
}

export async function listSegments(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "segment.manage");
  return withUow(sq, ctx, async (u) => (await u.repo("Segment").findAll({ order: [["createdAt", "DESC"]], transaction: u.tx })).map(plain));
}

// ---------------------------------------------------------------- campaigns
export const MAX_ATTEMPTS = 5;
const STALE_SENDING_MS = 5 * 60_000;
const LIVE = ["scheduled", "preparing", "running", "paused"];

const event = (u: Uow, campaignId: string, type: string, detail?: unknown) =>
  u.repo("CampaignEvent").create({ id: randomUUID(), campaignId, type, detail: detail ?? null, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });

export interface CreateCampaignInput {
  name: string; channel: MessageChannel; templateVersionId: string; segmentId: string; channelAccountId: string; purposeCode: string; maxPerMinute?: number; scheduledAt?: string;
}

export async function createCampaign(sq: Sequelize, ctx: RequestContext, i: CreateCampaignInput) {
  authorize(ctx, "campaign.manage");
  if ((i.maxPerMinute ?? 60) < 1 || (i.maxPerMinute ?? 60) > 6000) throw new ConflictError("maxPerMinute must be between 1 and 6000");
  return withUow(sq, ctx, async (u) => {
    const v: any = await u.repo("TemplateVersion").findById(i.templateVersionId, { transaction: u.tx });
    if (!v) throw new NotFoundError("Template version");
    const t: any = await u.repo("Template").findById(v.get("templateId"), { transaction: u.tx });
    if (t.get("channel") !== i.channel) throw new ConflictError("The template is for a different channel");
    if (t.get("status") !== "approved" || ["pending", "rejected"].includes(v.get("approvalStatus"))) throw new ConflictError("Only approved templates can be broadcast");
    if (!(await u.repo("Segment").findById(i.segmentId, { transaction: u.tx }))) throw new NotFoundError("Segment");
    if (!(await u.repo("ChannelAccount").findOne({ where: { id: i.channelAccountId, channel: i.channel, status: "active" }, transaction: u.tx }))) throw new NotFoundError("Channel account");
    if (!(await u.repo("ConsentPurpose").findOne({ where: { code: i.purposeCode }, transaction: u.tx }))) throw new ConflictError("Unknown consent purpose");
    const id = randomUUID();
    await u.repo("Campaign").create({
      id, name: i.name, channel: i.channel, templateVersionId: i.templateVersionId, segmentId: i.segmentId, channelAccountId: i.channelAccountId, purposeCode: i.purposeCode,
      status: "draft", scheduledAt: i.scheduledAt ? new Date(i.scheduledAt) : null, maxPerMinute: i.maxPerMinute ?? 60, createdBy: ctx.userId,
    }, { transaction: u.tx });
    await event(u, id, "created");
    return plain(await u.repo("Campaign").findById(id, { transaction: u.tx }));
  });
}

async function loadCampaign(u: Uow, id: string, lock = false) {
  if (lock) await u.sq.query("SELECT id FROM campaigns WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id, t: u.tenantId }, transaction: u.tx });
  const c: any = await u.repo("Campaign").findById(id, { transaction: u.tx });
  if (!c) throw new NotFoundError("Campaign");
  return c;
}

/** Schedule: draft -> scheduled. The scheduler (or `startCampaign`) prepares and runs it when due. */
export async function scheduleCampaign(sq: Sequelize, ctx: RequestContext, id: string, at?: string) {
  authorize(ctx, "campaign.manage");
  return withUow(sq, ctx, async (u) => {
    const c = await loadCampaign(u, id, true);
    if (c.get("status") !== "draft") throw new ConflictError(`A ${c.get("status")} campaign cannot be scheduled`);
    const when = at ? new Date(at) : c.get("scheduledAt") ? new Date(c.get("scheduledAt")) : new Date();
    await u.repo("Campaign").updateById(id, { status: "scheduled", scheduledAt: when }, { transaction: u.tx });
    await event(u, id, "scheduled", { at: when.toISOString() });
    await u.audit({ action: "campaign.scheduled", entityType: "campaign", entityId: id, after: { at: when.toISOString() } });
    return plain(await u.repo("Campaign").findById(id, { transaction: u.tx }));
  });
}

const valuesFor = (c: any) => ({ contact: { first_name: c.get("firstName"), last_name: c.get("lastName"), full_name: [c.get("firstName"), c.get("lastName")].filter(Boolean).join(" ") || c.get("companyName"), email: c.get("email"), phone: c.get("phoneE164") } });

/**
 * Snapshot the audience and decide, per person, whether they may be contacted. Everyone resolved is recorded - blocked people as
 * `skipped` with the reason - so "why didn't X get this?" is always answerable. The snapshot is immutable for the run.
 */
export async function prepareCampaign(sq: Sequelize, ctx: RequestContext, id: string) {
  const contacts = await withUow(sq, ctx, async (u) => {
    const c = await loadCampaign(u, id, true);
    if (c.get("status") !== "scheduled") throw new ConflictError(`A ${c.get("status")} campaign cannot be prepared`);
    await u.repo("Campaign").updateById(id, { status: "preparing" }, { transaction: u.tx });
    const seg: any = await u.repo("Segment").findById(c.get("segmentId"), { transaction: u.tx });
    return { channel: c.get("channel") as MessageChannel, purpose: c.get("purposeCode") as string, rows: await resolveSegmentContacts(u, seg.get("definition") as SegmentDefinition) };
  });
  let pending = 0, skipped = 0;
  for (const chunk of chunks(contacts.rows, 200)) {
    const decisions: Array<{ contact: any; gate: Awaited<ReturnType<typeof evaluateContactability>> }> = [];
    for (const contact of chunk) decisions.push({ contact, gate: await evaluateContactability(sq, ctx.tenantId, { contactId: contact.get("id"), channel: contacts.channel, purposeCode: contacts.purpose }) });
    await withUow(sq, ctx, async (u) => {
      for (const { contact, gate } of decisions) {
        const dest = gate.destination ?? "-";
        try {
          await u.repo("CampaignRecipient").create({
            id: randomUUID(), campaignId: id, contactId: contact.get("id"), destination: dest, channel: contacts.channel,
            status: gate.allowed ? "pending" : "skipped", skipReason: gate.allowed ? null : gate.reasons[0] ?? "blocked",
          }, { transaction: u.tx });
          gate.allowed ? pending++ : skipped++;
        } catch (e: any) {
          if (!(e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY")) throw e; // same person/destination twice: counted once
        }
      }
    });
  }
  return withUow(sq, ctx, async (u) => {
    const c = await loadCampaign(u, id, true);
    if (c.get("status") !== "preparing") return plain(c); // cancelled while preparing
    await u.repo("Campaign").updateById(id, { status: "running", startedAt: new Date(), totals: { audience: pending + skipped, pending, skipped } }, { transaction: u.tx });
    await event(u, id, "started", { audience: pending + skipped, pending, skipped });
    await u.audit({ action: "campaign.started", entityType: "campaign", entityId: id, after: { audience: pending + skipped, skipped } });
    await u.emit({ type: "campaign.started", aggregateType: "campaign", aggregateId: id, payload: { audience: pending + skipped } });
    return plain(await u.repo("Campaign").findById(id, { transaction: u.tx }));
  });
}

function* chunks<T>(a: T[], n: number) { for (let i = 0; i < a.length; i += n) yield a.slice(i, i + n); }

export interface BatchResult { processed: number; sent: number; failed: number; skipped: number; deferred: number; throttled: boolean; completed: boolean }

/**
 * Process up to `limit` pending recipients. Safe with several workers: rows are claimed (`sending`) under FOR UPDATE SKIP LOCKED,
 * stuck claims from a crashed worker are recovered, and every send is idempotent on `campaign:<id>:<recipient>`.
 * Before each send it re-checks: campaign still running, per-minute rate, consent/suppression right now (not at prepare time).
 */
export async function runCampaignBatch(sq: Sequelize, tenantId: string, id: string, limit = 50): Promise<BatchResult> {
  const ctx = systemContext(tenantId, `corr_${randomUUID()}`);
  const res: BatchResult = { processed: 0, sent: 0, failed: 0, skipped: 0, deferred: 0, throttled: false, completed: false };

  const claim = await withUow(sq, ctx, async (u) => {
    const c = await loadCampaign(u, id);
    if (c.get("status") !== "running") return null;
    await u.sq.query("UPDATE campaign_recipients SET status='pending' WHERE tenant_id=:t AND campaign_id=:c AND status='sending' AND updated_at < :cut", { replacements: { t: tenantId, c: id, cut: mysqlDate(new Date(Date.now() - STALE_SENDING_MS)) }, transaction: u.tx });
    const [row] = await u.sq.query<{ n: number }>("SELECT COUNT(*) n FROM campaign_recipients WHERE tenant_id=:t AND campaign_id=:c AND status IN ('sent','delivered','read','replied') AND sent_at > :since", { replacements: { t: tenantId, c: id, since: mysqlDate(new Date(Date.now() - 60_000)) }, transaction: u.tx, type: QueryTypes.SELECT });
    const room = Math.max(0, Number(c.get("maxPerMinute")) - Number(row?.n ?? 0));
    const take = Math.min(limit, room);
    res.throttled = take < limit && room === 0;
    const rows = take > 0
      ? await u.sq.query<{ id: string }>("SELECT id FROM campaign_recipients WHERE tenant_id=:t AND campaign_id=:c AND status='pending' ORDER BY created_at, id LIMIT :n FOR UPDATE SKIP LOCKED", { replacements: { t: tenantId, c: id, n: take }, transaction: u.tx, type: QueryTypes.SELECT })
      : [];
    if (rows.length) await u.sq.query("UPDATE campaign_recipients SET status='sending' WHERE tenant_id=:t AND id IN (:ids)", { replacements: { t: tenantId, ids: rows.map((r) => r.id) }, transaction: u.tx });
    return { campaign: plain(c), ids: rows.map((r) => r.id) };
  });
  if (!claim) return res;

  for (const rid of claim.ids) {
    // Cancelled or paused mid-batch: stop at once and give unprocessed claims back.
    const live: any = await sq.query("SELECT status FROM campaigns WHERE id=:id AND tenant_id=:t", { replacements: { id, t: tenantId }, type: QueryTypes.SELECT });
    if (live[0]?.status !== "running") { await sq.query("UPDATE campaign_recipients SET status='pending' WHERE tenant_id=:t AND campaign_id=:c AND status='sending'", { replacements: { t: tenantId, c: id } }); break; }
    const rec = (await sq.query<any>("SELECT * FROM campaign_recipients WHERE id=:id AND tenant_id=:t", { replacements: { id: rid, t: tenantId }, type: QueryTypes.SELECT }))[0];
    const contact = (await sq.query<any>("SELECT first_name, last_name, company_name, email, phone_e164 FROM contacts WHERE id=:id AND tenant_id=:t", { replacements: { id: rec.contact_id, t: tenantId }, type: QueryTypes.SELECT }))[0];
    const c = claim.campaign as any;
    res.processed++;
    const set = (status: string, extra: Record<string, unknown> = {}) =>
      sq.query("UPDATE campaign_recipients SET status=:nextStatus, skip_reason=:skipReason, last_error=:lastError, message_id=COALESCE(:messageId, message_id), attempts = attempts + (:attemptInc), sent_at=:sentAt WHERE id=:recipientId AND tenant_id=:tenantId",
        { replacements: { nextStatus: status, skipReason: (extra.skip as string) ?? null, lastError: (extra.error as string) ?? null, messageId: (extra.messageId as string) ?? null, attemptInc: extra.attempt ? 1 : 0, sentAt: status === "sent" ? mysqlDate(new Date()) : null, recipientId: rid, tenantId } });
    try {
      const r = await sendMessage(sq, ctx, {
        contactId: rec.contact_id, channel: c.channel, channelAccountId: c.channelAccountId, purposeCode: c.purposeCode, templateVersionId: c.templateVersionId, campaignId: id,
        idempotencyKey: `campaign:${id}:${rid}`,
        values: valuesFor({ get: (k: string) => ({ firstName: contact.first_name, lastName: contact.last_name, companyName: contact.company_name, email: contact.email, phoneE164: contact.phone_e164 })[k] }),
      });
      if (r.status === "sent") { await set("sent", { messageId: r.messageId, attempt: true }); res.sent++; }
      else if (r.status === "blocked") { await set("skipped", { skip: r.blockedReasons?.[0] ?? "blocked" }); res.skipped++; } // consent withdrawn since prepare
      else if (r.status === "failed") { await set("failed", { messageId: r.messageId, error: r.error, attempt: true }); res.failed++; }
      else if ((rec.attempts ?? 0) + 1 >= MAX_ATTEMPTS) { await set("failed", { error: `gave up after ${MAX_ATTEMPTS} attempts: ${r.error}`, attempt: true }); res.failed++; }
      else { await set("pending", { error: r.error, attempt: true }); res.deferred++; }
    } catch (e) {
      if (e instanceof MissingVariableError) { await set("skipped", { skip: "missing_variable", error: e.message }); res.skipped++; }
      else { await set("failed", { error: String((e as Error).message).slice(0, 400), attempt: true }); res.failed++; }
    }
  }

  await withUow(sq, ctx, async (u) => {
    const left = await u.repo("CampaignRecipient").count({ where: { campaignId: id, status: { [Op.in]: ["pending", "sending"] } }, transaction: u.tx });
    if (left === 0) {
      const c = await loadCampaign(u, id, true);
      if (c.get("status") === "running") {
        const totals = await totalsFor(u, id);
        await u.repo("Campaign").updateById(id, { status: "completed", completedAt: new Date(), totals }, { transaction: u.tx });
        await event(u, id, "completed", totals);
        await u.emit({ type: "campaign.completed", aggregateType: "campaign", aggregateId: id, payload: totals });
        res.completed = true;
      }
    }
  });
  return res;
}

async function totalsFor(u: Uow, id: string) {
  const rows = await u.sq.query<{ status: string; n: number }>("SELECT status, COUNT(*) n FROM campaign_recipients WHERE tenant_id=:t AND campaign_id=:c GROUP BY status", { replacements: { t: u.tenantId, c: id }, transaction: u.tx, type: QueryTypes.SELECT });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

async function control(sq: Sequelize, ctx: RequestContext, id: string, from: string[], to: string, type: string, reason?: string) {
  authorize(ctx, "campaign.manage");
  return withUow(sq, ctx, async (u) => {
    const c = await loadCampaign(u, id, true);
    if (!from.includes(c.get("status"))) throw new ConflictError(`A ${c.get("status")} campaign cannot be ${type}`);
    await u.repo("Campaign").updateById(id, { status: to, ...(to === "cancelled" ? { completedAt: new Date() } : {}) }, { transaction: u.tx });
    await event(u, id, type, reason ? { reason } : null);
    await u.audit({ action: `campaign.${type}`, entityType: "campaign", entityId: id, reason });
    await u.emit({ type: `campaign.${type}`, aggregateType: "campaign", aggregateId: id, payload: {} });
    return plain(await u.repo("Campaign").findById(id, { transaction: u.tx }));
  });
}
export const pauseCampaign = (sq: Sequelize, ctx: RequestContext, id: string) => control(sq, ctx, id, ["running"], "paused", "paused");
export const resumeCampaign = (sq: Sequelize, ctx: RequestContext, id: string) => control(sq, ctx, id, ["paused"], "running", "resumed");
export const cancelCampaign = async (sq: Sequelize, ctx: RequestContext, id: string, reason: string) => {
  if (!reason?.trim()) throw new ConflictError("A reason is required");
  return control(sq, ctx, id, LIVE, "cancelled", "cancelled", reason.trim());
};

export async function getCampaign(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "campaign.read");
  return withUow(sq, ctx, async (u) => {
    const c = await loadCampaign(u, id);
    const skipped = await u.sq.query<{ skip_reason: string; n: number }>("SELECT skip_reason, COUNT(*) n FROM campaign_recipients WHERE tenant_id=:t AND campaign_id=:c AND status='skipped' GROUP BY skip_reason", { replacements: { t: ctx.tenantId, c: id }, transaction: u.tx, type: QueryTypes.SELECT });
    const events = await u.repo("CampaignEvent").findAll({ where: { campaignId: id }, order: [["createdAt", "ASC"]], transaction: u.tx });
    return { ...plain(c), stats: await totalsFor(u, id), skippedByReason: Object.fromEntries(skipped.map((s) => [s.skip_reason, Number(s.n)])), events: events.map(plain) };
  });
}

export async function listCampaigns(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "campaign.read");
  return withUow(sq, ctx, async (u) => (await u.repo("Campaign").findAll({ order: [["createdAt", "DESC"]], limit: 100, transaction: u.tx })).map(plain));
}

/** Scheduler entry point: prepare due scheduled campaigns and run a batch of every running one, for one tenant. */
export async function tickCampaigns(sq: Sequelize, tenantId: string, batch = 100) {
  const ctx = systemContext(tenantId, `corr_${randomUUID()}`);
  const due = await withUow(sq, ctx, async (u) => (await u.repo("Campaign").findAll({ where: { status: "scheduled", scheduledAt: { [Op.lte]: new Date() } }, transaction: u.tx })).map((c: any) => c.get("id") as string));
  for (const id of due) await prepareCampaign(sq, { ...ctx, grants: [{ permission: "campaign.manage", scope: "tenant" }] }, id).catch(() => undefined);
  const running = await withUow(sq, ctx, async (u) => (await u.repo("Campaign").findAll({ where: { status: "running" }, transaction: u.tx })).map((c: any) => c.get("id") as string));
  const out = [];
  for (const id of running) out.push({ id, ...(await runCampaignBatch(sq, tenantId, id, batch)) });
  return out;
}

/** Attribution: campaign -> recipient -> conversation -> lead -> viewing -> deal, so "conversion" is never inferred from a reply alone. */
export async function campaignFunnel(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "campaign.read");
  return withUow(sq, ctx, async (u) => {
    await loadCampaign(u, id);
    const q = (sql: string) => u.sq.query<{ n: number }>(sql, { replacements: { t: ctx.tenantId, c: id }, transaction: u.tx, type: QueryTypes.SELECT }).then((r) => Number(r[0]?.n ?? 0));
    return {
      sent: await q("SELECT COUNT(*) n FROM campaign_recipients WHERE tenant_id=:t AND campaign_id=:c AND status IN ('sent','delivered','read','replied')"),
      delivered: await q("SELECT COUNT(*) n FROM campaign_recipients WHERE tenant_id=:t AND campaign_id=:c AND status IN ('delivered','read','replied')"),
      replied: await q("SELECT COUNT(*) n FROM campaign_recipients WHERE tenant_id=:t AND campaign_id=:c AND status='replied'"),
      leads: await q("SELECT COUNT(DISTINCT l.id) n FROM leads l JOIN campaign_recipients r ON r.contact_id=l.contact_id AND r.tenant_id=l.tenant_id WHERE r.tenant_id=:t AND r.campaign_id=:c AND l.created_at >= (SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(COALESCE(started_at, created_at)))) FROM campaigns WHERE id=:c)"),
      viewings: await q("SELECT COUNT(DISTINCT v.id) n FROM viewings v JOIN campaign_recipients r ON r.contact_id=v.contact_id AND r.tenant_id=v.tenant_id WHERE r.tenant_id=:t AND r.campaign_id=:c AND v.created_at >= (SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(COALESCE(started_at, created_at)))) FROM campaigns WHERE id=:c)"),
      deals: await q("SELECT COUNT(DISTINCT d.id) n FROM deals d JOIN campaign_recipients r ON r.contact_id=d.contact_id AND r.tenant_id=d.tenant_id WHERE r.tenant_id=:t AND r.campaign_id=:c AND d.status<>'cancelled' AND d.created_at >= (SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(COALESCE(started_at, created_at)))) FROM campaigns WHERE id=:c)"),
    };
  });
}
