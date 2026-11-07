import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { decryptField, encryptField, isApiKeyContext } from "@reales/auth";
import { matchesEvent } from "@reales/events";
import { logger } from "@reales/observability";
import { ForbiddenError, authorize } from "@reales/rbac";
import { plain } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

// ---------------------------------------------------------------- network safety (SSRF)

/** True for loopback, private, link-local, carrier-grade NAT, multicast and other addresses a webhook must never reach. */
export function isNonPublicAddress(addr: string): boolean {
  const v = net.isIP(addr);
  if (v === 4) {
    const [a, b] = addr.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = addr.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isNonPublicAddress(mapped[1]!);
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
  }
  return true;
}

/** Development escape hatch (local receivers). Never set in production. */
const allowLocal = () => process.env.WEBHOOK_ALLOW_PRIVATE === "1";

/** Validate a destination URL when it is saved. Delivery re-checks the resolved address at connect time (DNS rebinding). */
export function validateWebhookUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConflictError("That is not a valid URL"); }
  if (u.username || u.password) throw new ConflictError("Do not put credentials in the URL");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && allowLocal())) throw new ConflictError("The URL must start with https://");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!allowLocal() && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || (net.isIP(host) && isNonPublicAddress(host)))) throw new ConflictError("The URL must point to a public address");
  return u;
}

const guardedLookup = ((hostname: string, options: any, cb: any) => {
  const opts = typeof options === "object" && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs as unknown as dns.LookupAddress[];
    const ok = allowLocal() ? list : list.filter((a) => !isNonPublicAddress(a.address));
    if (!ok.length) return cb(new Error("Destination resolves to a non-public address"));
    if (opts.all) return cb(null, ok);
    cb(null, ok[0]!.address, ok[0]!.family);
  });
}) as unknown as typeof dns.lookup;

export interface WebhookSendResult { status: number | null; error?: string }
export type WebhookSender = (url: string, body: string, headers: Record<string, string>) => Promise<WebhookSendResult>;

/** Real transport: no redirects, 10 s timeout, response body discarded, address checked when the socket connects. */
export const httpSender: WebhookSender = (url, body, headers) => new Promise((resolve) => {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const req = lib.request(u, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, lookup: guardedLookup, timeout: 10_000 }, (res) => {
    res.resume();
    res.on("end", () => resolve({ status: res.statusCode ?? null }));
    res.on("error", (e) => resolve({ status: null, error: e.message }));
  });
  req.on("timeout", () => req.destroy(new Error("Timed out after 10 s")));
  req.on("error", (e) => resolve({ status: null, error: e.message.slice(0, 300) }));
  req.end(body);
});

// ---------------------------------------------------------------- signing

export const signPayload = (secret: string, timestamp: number, body: string) => createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
/** What a receiver does: recompute over `t.body`, compare in constant time, and reject timestamps older than a few minutes. */
export function verifySignature(secret: string, header: string, body: string, toleranceSec = 300, now = Date.now()): boolean {
  const t = /t=(\d+)/.exec(header)?.[1], v = /v1=([0-9a-f]{64})/.exec(header)?.[1];
  if (!t || !v || Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  return timingSafeEqual(Buffer.from(signPayload(secret, Number(t), body), "hex"), Buffer.from(v, "hex"));
}

// ---------------------------------------------------------------- management

export { matchesEvent };
const EVENT_PATTERN = /^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$/;
const humanOnly = (ctx: RequestContext) => { if (isApiKeyContext(ctx)) throw new ForbiddenError("API keys cannot manage API keys or webhooks"); };
const newSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;
const strip = (e: any) => { const { secretEnc: _s, ...rest } = plain(e); return rest; };

export interface EndpointInput { id?: string; name: string; url: string; eventTypes: string[]; active?: boolean }

function cleanEvents(list: string[]) {
  const ev = [...new Set(list.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (!ev.length) throw new ConflictError("Choose at least one event");
  const bad = ev.filter((x) => !EVENT_PATTERN.test(x));
  if (bad.length) throw new ConflictError(`Not a valid event pattern: ${bad.join(", ")}`);
  return ev;
}

/** The signing secret is returned ONCE on creation (and on rotate); it is stored encrypted. */
export async function saveWebhookEndpoint(sq: Sequelize, ctx: RequestContext, i: EndpointInput) {
  authorize(ctx, "webhook.manage");
  humanOnly(ctx);
  if (!i.name.trim()) throw new ConflictError("Give the endpoint a name");
  const url = validateWebhookUrl(i.url).toString();
  const eventTypes = cleanEvents(i.eventTypes);
  return withUow(sq, ctx, async (u) => {
    if (i.id) {
      const cur: any = await u.repo("WebhookEndpoint").findById(i.id, { transaction: u.tx });
      if (!cur) throw new NotFoundError("Webhook endpoint");
      const reenable = i.active === true && !cur.get("active");
      await u.repo("WebhookEndpoint").updateById(i.id, { name: i.name.trim().slice(0, 120), url, eventTypes, ...(i.active === undefined ? {} : { active: i.active }), ...(reenable ? { consecutiveFailures: 0, disabledReason: null } : {}) }, { transaction: u.tx });
      await u.audit({ action: "webhook.updated", entityType: "webhook_endpoint", entityId: i.id, after: { url, eventTypes, active: i.active } });
      return { endpoint: strip(await u.repo("WebhookEndpoint").findById(i.id, { transaction: u.tx })) };
    }
    const count = await u.repo("WebhookEndpoint").count({ transaction: u.tx });
    if (count >= 20) throw new ConflictError("At most 20 endpoints per company");
    const id = randomUUID(), secret = newSecret();
    await u.repo("WebhookEndpoint").create({ id, name: i.name.trim().slice(0, 120), url, secretEnc: encryptField(secret), eventTypes, active: true, consecutiveFailures: 0, createdBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: "webhook.created", entityType: "webhook_endpoint", entityId: id, after: { url, eventTypes } });
    return { endpoint: strip(await u.repo("WebhookEndpoint").findById(id, { transaction: u.tx })), secret };
  });
}

export async function rotateWebhookSecret(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "webhook.manage");
  humanOnly(ctx);
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("WebhookEndpoint").findById(id, { transaction: u.tx }))) throw new NotFoundError("Webhook endpoint");
    const secret = newSecret();
    await u.repo("WebhookEndpoint").updateById(id, { secretEnc: encryptField(secret) }, { transaction: u.tx });
    await u.audit({ action: "webhook.secret_rotated", entityType: "webhook_endpoint", entityId: id });
    return { secret };
  });
}

export async function deleteWebhookEndpoint(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "webhook.manage");
  humanOnly(ctx);
  return withUow(sq, ctx, async (u) => {
    const e: any = await u.repo("WebhookEndpoint").findById(id, { transaction: u.tx });
    if (!e) throw new NotFoundError("Webhook endpoint");
    await u.sq.query("DELETE FROM webhook_deliveries WHERE tenant_id=:t AND endpoint_id=:id", { replacements: { t: ctx.tenantId, id }, transaction: u.tx });
    await u.repo("WebhookEndpoint").deleteById(id, { transaction: u.tx });
    await u.audit({ action: "webhook.deleted", entityType: "webhook_endpoint", entityId: id, after: { url: e.get("url") } });
  });
}

export async function listWebhookEndpoints(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "webhook.manage");
  humanOnly(ctx);
  return withUow(sq, ctx, async (u) => {
    const rows = (await u.repo("WebhookEndpoint").findAll({ order: [["createdAt", "DESC"]], transaction: u.tx })) as any[];
    const stats = await u.sq.query<{ endpoint_id: string; status: string; n: number }>("SELECT endpoint_id, status, COUNT(*) AS n FROM webhook_deliveries WHERE tenant_id=:t GROUP BY endpoint_id, status", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    return rows.map((r) => ({ ...strip(r), counts: Object.fromEntries(stats.filter((s) => s.endpoint_id === r.get("id")).map((s) => [s.status, Number(s.n)])) }));
  });
}

export async function listWebhookDeliveries(sq: Sequelize, ctx: RequestContext, endpointId: string, status?: string) {
  authorize(ctx, "webhook.manage");
  humanOnly(ctx);
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("WebhookEndpoint").findById(endpointId, { transaction: u.tx }))) throw new NotFoundError("Webhook endpoint");
    const where: Record<string, unknown> = { endpointId, ...(status ? { status } : {}) };
    return (await u.repo("WebhookDelivery").findAll({ where, order: [["createdAt", "DESC"]], limit: 100, transaction: u.tx })).map((d: any) => { const { payload: _p, ...rest } = plain(d); return rest; });
  });
}

/** Put a failed (or stuck) delivery back in the queue. */
export async function retryWebhookDelivery(sq: Sequelize, ctx: RequestContext, deliveryId: string) {
  authorize(ctx, "webhook.manage");
  humanOnly(ctx);
  return withUow(sq, ctx, async (u) => {
    const d: any = await u.repo("WebhookDelivery").findById(deliveryId, { transaction: u.tx });
    if (!d) throw new NotFoundError("Delivery");
    if (d.get("status") === "delivered") throw new ConflictError("That delivery already succeeded");
    await u.repo("WebhookDelivery").updateById(deliveryId, { status: "pending", attempts: 0, nextAttemptAt: mysqlDate(new Date()), lastError: null }, { transaction: u.tx });
    await u.audit({ action: "webhook.delivery_retried", entityType: "webhook_delivery", entityId: deliveryId });
  });
}

export interface Envelope { id: string; type: string; version: number; tenantId: string; aggregateType: string; aggregateId: string; occurredAt: string; data: unknown }

/** Queue a `webhook.test` event for one endpoint and try it now, so the result shows straight away. */
export async function sendTestWebhook(sq: Sequelize, ctx: RequestContext, endpointId: string, send: WebhookSender = httpSender) {
  authorize(ctx, "webhook.manage");
  humanOnly(ctx);
  const deliveryId = await withUow(sq, ctx, async (u) => {
    if (!(await u.repo("WebhookEndpoint").findById(endpointId, { transaction: u.tx }))) throw new NotFoundError("Webhook endpoint");
    const id = randomUUID(), eventId = randomUUID();
    const payload: Envelope = { id: eventId, type: "webhook.test", version: 1, tenantId: ctx.tenantId, aggregateType: "webhook_endpoint", aggregateId: endpointId, occurredAt: new Date().toISOString(), data: { message: "This is a test delivery from Reales CRM" } };
    await u.repo("WebhookDelivery").create({ id, endpointId, eventId, eventType: "webhook.test", payload, status: "pending", attempts: 0, nextAttemptAt: mysqlDate(new Date()) }, { transaction: u.tx });
    return id;
  });
  await deliverWebhooks(sq, { send, onlyId: deliveryId });
  return withUow(sq, ctx, async (u) => { const d: any = await u.repo("WebhookDelivery").findById(deliveryId, { transaction: u.tx }); const { payload: _p, ...rest } = plain(d); return rest; });
}

// ---------------------------------------------------------------- delivery worker

const MAX_ATTEMPTS = 8;
const DISABLE_AFTER = 20;
const LEASE_MS = 2 * 60_000;
export const retryDelayMs = (attempts: number) => Math.min(6 * 3600_000, 30_000 * 2 ** (attempts - 1));

/**
 * One pass over due deliveries (all tenants). Rows are leased under SKIP LOCKED so several workers can run, then sent OUTSIDE any transaction.
 * 2xx = delivered; anything else retries with backoff up to 8 times, then the delivery is marked failed (a manager can retry it). An endpoint that
 * fails 20 deliveries in a row is switched off with a reason.
 */
export async function deliverWebhooks(sq: Sequelize, o: { send?: WebhookSender; limit?: number; onlyId?: string; now?: Date } = {}): Promise<{ delivered: number; failed: number; retried: number }> {
  const send = o.send ?? httpSender;
  const now = o.now ?? new Date();
  const claimed = await sq.transaction(async (tx) => {
    const rows = await sq.query<any>(
      `SELECT * FROM webhook_deliveries WHERE status='pending' AND next_attempt_at <= :now ${o.onlyId ? "AND id = :only" : ""} ORDER BY next_attempt_at ASC LIMIT ${Number(o.limit ?? 50)} FOR UPDATE SKIP LOCKED`,
      { replacements: { now: mysqlDate(now), only: o.onlyId ?? null }, transaction: tx, type: QueryTypes.SELECT },
    );
    if (rows.length) await sq.query("UPDATE webhook_deliveries SET next_attempt_at=:lease WHERE id IN (:ids)", { replacements: { lease: mysqlDate(new Date(now.getTime() + LEASE_MS)), ids: rows.map((r: any) => r.id) }, transaction: tx });
    return rows;
  });
  const res = { delivered: 0, failed: 0, retried: 0 };
  for (const d of claimed) {
    const [ep] = await sq.query<any>("SELECT id, url, secret_enc, active, consecutive_failures FROM webhook_endpoints WHERE id=:id AND tenant_id=:t", { replacements: { id: d.endpoint_id, t: d.tenant_id }, type: QueryTypes.SELECT });
    if (!ep || (!ep.active && d.event_type !== "webhook.test")) {
      await sq.query("UPDATE webhook_deliveries SET status='failed', last_error=:e WHERE id=:id", { replacements: { id: d.id, e: ep ? "Endpoint is switched off" : "Endpoint was deleted" } });
      res.failed++;
      continue;
    }
    const body = typeof d.payload === "string" ? d.payload : JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000);
    let out: WebhookSendResult;
    try {
      out = await send(ep.url, body, {
        "content-type": "application/json", "user-agent": "Reales-Webhooks/1", "x-reales-event": d.event_type, "x-reales-delivery": d.id,
        "x-reales-signature": `t=${ts},v1=${signPayload(decryptField(ep.secret_enc), ts, body)}`,
      });
    } catch (e) { out = { status: null, error: String((e as Error).message ?? e).slice(0, 300) }; }
    const ok = out.status !== null && out.status >= 200 && out.status < 300;
    const attempts = d.attempts + 1;
    if (ok) {
      await sq.query("UPDATE webhook_deliveries SET status='delivered', attempts=:a, response_status=:s, last_error=NULL, delivered_at=:now WHERE id=:id", { replacements: { id: d.id, a: attempts, s: out.status, now: mysqlDate(now) } });
      await sq.query("UPDATE webhook_endpoints SET consecutive_failures=0 WHERE id=:id AND tenant_id=:t", { replacements: { id: ep.id, t: d.tenant_id } });
      res.delivered++;
      continue;
    }
    const err = (out.error ?? `HTTP ${out.status}`).slice(0, 480);
    const dead = attempts >= MAX_ATTEMPTS || d.event_type === "webhook.test";
    await sq.query("UPDATE webhook_deliveries SET status=:st, attempts=:a, response_status=:s, last_error=:e, next_attempt_at=:next WHERE id=:id", {
      replacements: { id: d.id, st: dead ? "failed" : "pending", a: attempts, s: out.status, e: err, next: mysqlDate(new Date(now.getTime() + retryDelayMs(attempts))) },
    });
    if (dead) res.failed++; else res.retried++;
    if (d.event_type !== "webhook.test") {
      await sq.query("UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id=:id AND tenant_id=:t", { replacements: { id: ep.id, t: d.tenant_id } });
      await sq.query("UPDATE webhook_endpoints SET active=0, disabled_reason=:r WHERE id=:id AND tenant_id=:t AND consecutive_failures >= :n AND active=1", { replacements: { id: ep.id, t: d.tenant_id, n: DISABLE_AFTER, r: `Switched off after ${DISABLE_AFTER} failed deliveries in a row (last: ${err})`.slice(0, 255) } });
    }
    logger.warn({ deliveryId: d.id, endpointId: ep.id, attempts, status: out.status }, "webhook delivery failed");
  }
  return res;
}

/** Housekeeping: delivered rows older than 30 days and failed rows older than 90 days go. */
export async function pruneWebhookDeliveries(sq: Sequelize, now = new Date()) {
  await sq.query("DELETE FROM webhook_deliveries WHERE (status='delivered' AND created_at < :a) OR (status='failed' AND created_at < :b)", { replacements: { a: mysqlDate(new Date(now.getTime() - 30 * 86_400_000)), b: mysqlDate(new Date(now.getTime() - 90 * 86_400_000)) } });
}
