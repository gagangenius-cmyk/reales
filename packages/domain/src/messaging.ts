import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, RequestContext, systemContext } from "@reales/database";
import { authorize, hasPermission } from "@reales/rbac";
import { CONTACT_SCOPE } from "./contacts";
import { destinationFor, evaluateContactability, recordConsent } from "./consent";
import { normalizeEmail, normalizePhone } from "./normalize";
import { hmacHex, verifyHmac } from "./providers";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { MessageChannel as Channel, renderTemplate, VariableValues as VariableValuesT } from "./templating";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

// ---------------------------------------------------------------- provider abstraction
export class MessagingError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
    this.name = "MessagingError";
  }
}

export interface OutboundMessage { channel: Channel; to: string; subject?: string | null; body: string; idempotencyKey: string; from: string }
export interface DeliveryStatusEvent { eventId: string; providerMessageId: string; status: "sent" | "delivered" | "read" | "failed"; occurredAt: string; error?: string }
export interface InboundEvent { eventId: string; channel: Channel; from: string; /** The receiving identity (our number or address): how a provider callback is routed to a tenant. */ to?: string; body: string; providerMessageId: string; occurredAt: string }

/** Vendor-neutral messaging contract (WhatsApp Business, SMS and email providers all implement it). */
export interface MessagingProvider {
  readonly code: string;
  send(m: OutboundMessage): Promise<{ providerMessageId: string }>;
  verifyWebhook(rawBody: string, headers: Record<string, string | null | undefined>): boolean;
  parseWebhook(rawBody: string): { kind: "status"; event: DeliveryStatusEvent } | { kind: "inbound"; event: InboundEvent };
}

const registry = new Map<string, MessagingProvider>();
export const registerMessagingProvider = (p: MessagingProvider) => void registry.set(p.code, p);
export const getMessagingProvider = (code: string) => registry.get(code) ?? null;

const mockSecret = () => process.env.MOCK_WEBHOOK_SECRET ?? "dev-mock-webhook-secret";

/** Development provider. Records what it "sent" and can be told to fail, so retry and failure paths are testable. */
export class MockMessagingProvider implements MessagingProvider {
  readonly code = "mock";
  sent: OutboundMessage[] = [];
  private failures: Array<{ retryable: boolean; message: string }> = [];
  private byKey = new Map<string, string>();
  failNext(n = 1, retryable = true, message = "provider unavailable") { for (let i = 0; i < n; i++) this.failures.push({ retryable, message }); }
  reset() { this.sent = []; this.failures = []; this.byKey.clear(); }
  async send(m: OutboundMessage) {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_PROVIDERS !== "1") throw new MessagingError("The mock messaging provider is disabled in production", false);
    const f = this.failures.shift();
    if (f) throw new MessagingError(f.message, f.retryable);
    // Real providers dedupe on the idempotency key too.
    const prior = this.byKey.get(m.idempotencyKey);
    if (prior) return { providerMessageId: prior };
    const id = `mock_msg_${randomUUID()}`;
    this.byKey.set(m.idempotencyKey, id);
    this.sent.push(m);
    return { providerMessageId: id };
  }
  verifyWebhook(rawBody: string, headers: Record<string, string | null | undefined>) { return verifyHmac(mockSecret(), rawBody, headers["x-mock-signature"]); }
  parseWebhook(rawBody: string) {
    const j = JSON.parse(rawBody);
    if (j.kind === "inbound") return { kind: "inbound" as const, event: { eventId: String(j.eventId), channel: j.channel, from: String(j.from), to: j.to ? String(j.to) : undefined, body: String(j.body), providerMessageId: String(j.providerMessageId), occurredAt: j.occurredAt ?? new Date().toISOString() } };
    if (j.kind === "status") return { kind: "status" as const, event: { eventId: String(j.eventId), providerMessageId: String(j.providerMessageId), status: j.status, occurredAt: j.occurredAt ?? new Date().toISOString(), error: j.error } };
    throw new Error("Malformed messaging webhook");
  }
}
export const mockMessaging = new MockMessagingProvider();
registerMessagingProvider(mockMessaging);

export function buildMockMessagingWebhook(e: Record<string, unknown> & { kind: "status" | "inbound" }) {
  const rawBody = JSON.stringify({ eventId: `evt_${randomUUID()}`, occurredAt: new Date().toISOString(), ...e });
  return { rawBody, headers: { "x-mock-signature": hmacHex(mockSecret(), rawBody) } };
}

// ---------------------------------------------------------------- sending
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };
const WA_WINDOW_MS = 24 * 3_600_000;

export interface SendInput {
  contactId: string; channel: Channel; channelAccountId?: string; purposeCode: string; idempotencyKey: string;
  body?: string; subject?: string | null;
  /** Send from an approved template version (required for WhatsApp outside the 24h customer-service window). */
  templateVersionId?: string; values?: VariableValuesT;
  campaignId?: string; workflowRunId?: string; senderUserId?: string | null;
}

export interface SendResult { messageId: string; status: "sent" | "failed" | "blocked" | "queued"; blockedReasons?: string[]; retryable?: boolean; replayed?: boolean; error?: string }

async function pickAccount(u: Uow, channel: Channel, id?: string) {
  const a: any = id
    ? await u.repo("ChannelAccount").findOne({ where: { id, channel, status: "active" }, transaction: u.tx })
    : await u.repo("ChannelAccount").findOne({ where: { channel, status: "active" }, order: [["createdAt", "ASC"]], transaction: u.tx });
  if (!a) throw new ConflictError(`No active ${channel} channel account is configured`);
  return a;
}

/**
 * The single outbound path (manual sends, broadcasts, workflows, bots). Order matters:
 *   1. idempotency  2. consent/suppression gate  3. WhatsApp session-window rule  4. render  5. persist queued  6. provider call  7. persist outcome.
 * The provider call happens OUTSIDE a database transaction, so a slow provider never holds locks, and a crash between 5 and 7
 * leaves a `queued` row that a retry (same idempotency key) resumes instead of duplicating.
 */
export async function sendMessage(sq: Sequelize, ctx: RequestContext, i: SendInput): Promise<SendResult> {
  // 1. replay
  const existing = await withUow(sq, ctx, async (u) => u.repo("Message").findOne({ where: { idempotencyKey: i.idempotencyKey }, transaction: u.tx }));
  if (existing && (existing as any).get("status") !== "queued") {
    return { messageId: (existing as any).get("id"), status: (existing as any).get("status") === "failed" ? "failed" : "sent", replayed: true };
  }

  // 2. consent / suppression
  const gate = await evaluateContactability(sq, ctx.tenantId, { contactId: i.contactId, channel: i.channel, purposeCode: i.purposeCode });
  if (!gate.allowed) return { messageId: "", status: "blocked", blockedReasons: gate.reasons };

  const prepared = await withUow(sq, ctx, async (u) => {
    const account = await pickAccount(u, i.channel, i.channelAccountId);
    let conv: any = await u.repo("Conversation").findOne({ where: { contactId: i.contactId, channel: i.channel }, transaction: u.tx });
    // 3. WhatsApp: free-form only inside 24h of the customer's last message
    let body = i.body ?? "";
    let subject = i.subject ?? null;
    let versionId: string | null = null;
    if (i.templateVersionId) {
      const v: any = await u.repo("TemplateVersion").findById(i.templateVersionId, { transaction: u.tx });
      if (!v) throw new NotFoundError("Template version");
      const t: any = await u.repo("Template").findById(v.get("templateId"), { transaction: u.tx });
      if (t.get("channel") !== i.channel) throw new ConflictError("The template is for a different channel");
      if (t.get("status") !== "approved") throw new ConflictError("Only approved templates can be sent");
      if (v.get("approvalStatus") === "pending" || v.get("approvalStatus") === "rejected") throw new ConflictError("This template version is not approved");
      versionId = v.get("id");
      const html = i.channel === "email" && !!v.get("renderedHtml");
      const src = i.channel === "whatsapp" ? (v.get("structuredComponentsJson")?.body?.text ?? "") : html ? v.get("renderedHtml") : (v.get("textBody") ?? "");
      body = renderTemplate(src, i.values ?? {}, { html });
      subject = v.get("subject") ? renderTemplate(v.get("subject"), i.values ?? {}) : null;
    } else if (i.channel === "whatsapp") {
      const last = conv?.get("lastInboundAt") ? new Date(conv.get("lastInboundAt")).getTime() : 0;
      if (Date.now() - last > WA_WINDOW_MS) throw new ConflictError("WhatsApp free-form messages are only allowed within 24 hours of the customer's last message; use an approved template");
    }
    if (!body.trim()) throw new ConflictError("The message is empty");
    const now = new Date();
    if (!conv) {
      conv = await u.repo("Conversation").create({ id: randomUUID(), contactId: i.contactId, channel: i.channel, channelAccountId: account.get("id"), status: "open", unreadCount: 0, lastMessageAt: now }, { transaction: u.tx });
    }
    let msg: any = existing as any;
    if (!msg) {
      try {
        msg = await u.repo("Message").create({
          id: randomUUID(), conversationId: conv.get("id"), direction: "outbound", channel: i.channel, status: "queued", body, subject, templateVersionId: versionId,
          campaignId: i.campaignId ?? null, workflowRunId: i.workflowRunId ?? null, provider: account.get("provider"), idempotencyKey: i.idempotencyKey,
          senderUserId: i.senderUserId ?? null, occurredAt: now,
        }, { transaction: u.tx });
      } catch (e: any) {
        if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") throw new ConflictError("A message with this idempotency key is already being sent");
        throw e;
      }
    }
    await u.repo("Conversation").updateById(conv.get("id"), { lastMessageAt: now, status: "open" }, { transaction: u.tx });
    return { messageId: msg.get("id") as string, body: msg.get("body") as string, subject: msg.get("subject") as string | null, provider: account.get("provider") as string, from: account.get("identity") as string };
  });

  // 6. provider call, outside any transaction
  const provider = getMessagingProvider(prepared.provider);
  const settle = async (status: "sent" | "failed", extra: Record<string, unknown>) =>
    withUow(sq, ctx, async (u) => {
      await u.repo("Message").updateById(prepared.messageId, { status, ...extra }, { transaction: u.tx });
      await u.emit({ type: status === "sent" ? "message.sent" : "message.failed", aggregateType: "message", aggregateId: prepared.messageId, payload: { channel: i.channel, contactId: i.contactId, campaignId: i.campaignId ?? null } });
    });
  if (!provider) { await settle("failed", { error: "unknown provider" }); return { messageId: prepared.messageId, status: "failed", retryable: false, error: "unknown provider" }; }
  try {
    const r = await provider.send({ channel: i.channel, to: gate.destination!, subject: prepared.subject, body: prepared.body, idempotencyKey: i.idempotencyKey, from: prepared.from });
    await settle("sent", { providerMessageId: r.providerMessageId, error: null });
    return { messageId: prepared.messageId, status: "sent" };
  } catch (e) {
    const retryable = e instanceof MessagingError ? e.retryable : true;
    const error = String((e as Error).message).slice(0, 500);
    // A retryable failure leaves the row `queued` so the same idempotency key can resume it; a permanent failure is final.
    if (!retryable) await settle("failed", { error });
    return { messageId: prepared.messageId, status: retryable ? "queued" : "failed", retryable, error };
  }
}

// ---------------------------------------------------------------- user-facing inbox
export const CONVERSATION_SCOPE: ScopeColumns = { owner: "assignedUserId", branch: "branchId" };

/** A person may message a contact only when they can see that contact and hold inbox.send for it. */
export async function sendUserMessage(sq: Sequelize, ctx: RequestContext, i: Omit<SendInput, "senderUserId" | "idempotencyKey"> & { idempotencyKey?: string }) {
  const contact: any = await withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "contact.read", CONTACT_SCOPE);
    return u.repo("Contact").findOne({ where: { [Op.and]: [{ id: i.contactId }, scope] }, transaction: u.tx });
  });
  if (!contact) throw new NotFoundError("Contact");
  authorize(ctx, "inbox.send", { ownerUserId: contact.get("ownerUserId"), branchId: contact.get("branchId") });
  return sendMessage(sq, ctx, { ...i, idempotencyKey: i.idempotencyKey ?? `user:${ctx.userId}:${randomUUID()}`, senderUserId: ctx.userId });
}

export async function listConversations(sq: Sequelize, ctx: RequestContext, f: { limit: number; offset: number; status?: string; unreadOnly?: boolean }) {
  return withUow(sq, ctx, async (u) => {
    if (!hasPermission(ctx, "inbox.read")) throw new NotFoundError("Inbox");
    const scope = await scopeWhere(u, ctx, "inbox.read", CONVERSATION_SCOPE);
    const and: any[] = [scope];
    if (f.status) and.push({ status: f.status });
    if (f.unreadOnly) and.push({ unreadCount: { [Op.gt]: 0 } });
    return (await u.repo("Conversation").findAll({ where: { [Op.and]: and }, order: [["lastMessageAt", "DESC"]], limit: f.limit, offset: f.offset, transaction: u.tx })).map(plain);
  });
}

export async function getConversation(sq: Sequelize, ctx: RequestContext, id: string, markRead = true) {
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "inbox.read", CONVERSATION_SCOPE);
    const c: any = await u.repo("Conversation").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
    if (!c) throw new NotFoundError("Conversation");
    const messages = await u.repo("Message").findAll({ where: { conversationId: id }, order: [["occurredAt", "ASC"]], limit: 500, transaction: u.tx });
    if (markRead && c.get("unreadCount") > 0) await u.repo("Conversation").updateById(id, { unreadCount: 0 }, { transaction: u.tx });
    return { ...plain(c), messages: messages.map(plain) };
  });
}

// ---------------------------------------------------------------- inbound and delivery callbacks
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|الغاء|إلغاء|ايقاف|إيقاف)\s*[.!]?\s*$/i;

/**
 * Apply a VERIFIED inbound message: attach it to the contact's conversation (creating the contact if the number is new),
 * and treat a STOP keyword as an immediate opt-out (consent revoked + destination suppressed) before anything else can reply.
 */
export async function receiveInbound(sq: Sequelize, tenantId: string, ev: InboundEvent, providerCode: string): Promise<{ messageId: string; optedOut: boolean; duplicate: boolean }> {
  const ctx = systemContext(tenantId, `corr_${randomUUID()}`);
  const dest = ev.channel === "email" ? normalizeEmail(ev.from) : normalizePhone(ev.from);
  if (!dest) throw new ConflictError("Unusable sender address");
  const out = await withUow(sq, ctx, async (u) => {
    const dup: any = await u.repo("Message").findOne({ where: { provider: providerCode, providerMessageId: ev.providerMessageId }, transaction: u.tx });
    if (dup) return { messageId: dup.get("id") as string, contactId: dup.get("conversationId") as string, duplicate: true, leadId: null as string | null, newContact: false };
    let contact: any = await u.repo("Contact").findOne({ where: ev.channel === "email" ? { normalizedEmail: dest } : { phoneE164: dest }, order: [["createdAt", "ASC"]], transaction: u.tx });
    let newContact = false;
    if (!contact) {
      contact = await u.repo("Contact").create({ id: randomUUID(), type: "person", ...(ev.channel === "email" ? { email: dest, normalizedEmail: dest } : { phoneE164: dest }), status: "active" }, { transaction: u.tx });
      newContact = true;
      await u.emit({ type: "contact.created", aggregateType: "contact", aggregateId: contact.get("id"), payload: { via: ev.channel } });
    }
    const at = new Date(ev.occurredAt);
    let conv: any = await u.repo("Conversation").findOne({ where: { contactId: contact.get("id"), channel: ev.channel }, transaction: u.tx });
    if (!conv) {
      const account: any = await u.repo("ChannelAccount").findOne({ where: { channel: ev.channel, status: "active" }, transaction: u.tx });
      const lead: any = await u.repo("Lead").findOne({ where: { contactId: contact.get("id"), status: "open" }, order: [["createdAt", "DESC"]], transaction: u.tx });
      conv = await u.repo("Conversation").create({
        id: randomUUID(), contactId: contact.get("id"), channel: ev.channel, channelAccountId: account?.get("id") ?? null, leadId: lead?.get("id") ?? null,
        assignedUserId: lead?.get("assignedUserId") ?? contact.get("ownerUserId") ?? null, branchId: lead?.get("branchId") ?? contact.get("branchId") ?? null,
        status: "open", unreadCount: 0, lastMessageAt: at,
      }, { transaction: u.tx });
    }
    const msg = await u.repo("Message").create({
      id: randomUUID(), conversationId: conv.get("id"), direction: "inbound", channel: ev.channel, status: "received", body: ev.body, provider: providerCode, providerMessageId: ev.providerMessageId, occurredAt: at,
    }, { transaction: u.tx });
    await u.repo("Conversation").updateById(conv.get("id"), { lastMessageAt: at, lastInboundAt: at, unreadCount: Number(conv.get("unreadCount")) + 1, status: "open" }, { transaction: u.tx });
    await u.emit({ type: "message.received", aggregateType: "conversation", aggregateId: conv.get("id"), payload: { contactId: contact.get("id"), channel: ev.channel, leadId: conv.get("leadId") } });
    if (conv.get("leadId")) await u.emit({ type: "lead.replied", aggregateType: "lead", aggregateId: conv.get("leadId"), payload: { channel: ev.channel } });
    // A reply counts as a response for any campaign recipient of this contact/destination.
    await u.sq.query(
      "UPDATE campaign_recipients SET status='replied' WHERE tenant_id=:t AND contact_id=:c AND channel=:ch AND status IN ('sent','delivered','read')",
      { replacements: { t: tenantId, c: contact.get("id"), ch: ev.channel }, transaction: u.tx },
    );
    return { messageId: msg.get("id") as string, contactId: contact.get("id") as string, duplicate: false, leadId: conv.get("leadId") as string | null, newContact };
  });
  if (out.duplicate) return { messageId: out.messageId, optedOut: false, duplicate: true };
  let optedOut = false;
  if (STOP.test(ev.body)) {
    // Revoke every consent purpose for this channel and suppress the destination.
    const purposes = await sq.query<{ code: string }>("SELECT code FROM consent_purposes WHERE tenant_id=:t", { replacements: { t: tenantId }, type: QueryTypes.SELECT });
    let first = true;
    for (const p of purposes) {
      await recordConsent(sq, ctx, { contactId: out.contactId, purposeCode: p.code, channel: ev.channel, granted: false, source: "inbound_stop_keyword", suppress: first });
      first = false;
    }
    if (!purposes.length) await sq.query("INSERT IGNORE INTO suppression_entries (id, tenant_id, channel, destination, reason, created_at, updated_at) VALUES (UUID(), :t, :ch, :d, 'unsubscribed', NOW(3), NOW(3))", { replacements: { t: tenantId, ch: ev.channel, d: dest } });
    optedOut = true;
  }
  return { messageId: out.messageId, optedOut, duplicate: false };
}

/** Delivery callbacks only ever move a message forward (a late "sent" cannot undo "delivered"); failure is terminal unless already read. */
export async function applyDeliveryStatus(sq: Sequelize, tenantId: string, ev: DeliveryStatusEvent, providerCode: string): Promise<"applied" | "ignored"> {
  const ctx = systemContext(tenantId, `corr_${randomUUID()}`);
  return withUow(sq, ctx, async (u) => {
    const m: any = await u.repo("Message").findOne({ where: { provider: providerCode, providerMessageId: ev.providerMessageId, direction: "outbound" }, transaction: u.tx });
    if (!m) throw new NotFoundError("Message");
    await u.sq.query("SELECT id FROM messages WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: m.get("id"), t: tenantId }, transaction: u.tx });
    const cur = (await u.repo("Message").findById(m.get("id"), { transaction: u.tx }) as any).get("status") as string;
    await u.repo("MessageEvent").create({ id: randomUUID(), messageId: m.get("id"), type: ev.status, providerEventId: ev.eventId, payload: { error: ev.error ?? null }, createdAt: mysqlDate(new Date(ev.occurredAt)) }, { transaction: u.tx });
    const forward = ev.status === "failed" ? RANK[cur] !== undefined && RANK[cur]! < RANK.read! && cur !== "failed" : (RANK[ev.status] ?? -1) > (RANK[cur] ?? -1);
    if (!forward) return "ignored";
    await u.repo("Message").updateById(m.get("id"), { status: ev.status, error: ev.status === "failed" ? (ev.error ?? "failed").slice(0, 500) : null }, { transaction: u.tx });
    const recStatus = ev.status === "failed" ? "failed" : ev.status;
    await u.sq.query(
      "UPDATE campaign_recipients SET status=:s WHERE tenant_id=:t AND message_id=:m AND status NOT IN ('replied','skipped') AND (:s = 'failed' OR FIELD(status,'pending','sending','sent','delivered','read') < FIELD(:s,'pending','sending','sent','delivered','read'))",
      { replacements: { s: recStatus, t: tenantId, m: m.get("id") }, transaction: u.tx },
    );
    await u.emit({ type: `message.${ev.status}`, aggregateType: "message", aggregateId: m.get("id"), payload: { channel: m.get("channel"), campaignId: m.get("campaignId") } });
    return "applied";
  });
}

export async function createChannelAccount(sq: Sequelize, ctx: RequestContext, i: { channel: Channel; provider: string; name: string; identity: string; config?: Record<string, unknown> }) {
  authorize(ctx, "channel.manage");
  if (!getMessagingProvider(i.provider)) throw new ConflictError("Unknown messaging provider");
  return withUow(sq, ctx, async (u) => {
    const a = await u.repo("ChannelAccount").create({ id: randomUUID(), ...i, config: i.config ?? {}, status: "active" }, { transaction: u.tx });
    await u.audit({ action: "channel_account.created", entityType: "channel_account", entityId: (a as any).get("id"), after: { channel: i.channel, provider: i.provider } });
    return plain(a);
  });
}

void destinationFor;
