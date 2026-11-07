import { randomUUID } from "node:crypto";
import { QueryTypes } from "sequelize";
import { afterAll, describe, expect, it } from "vitest";
import { AuthError, resolveRequestContext } from "@reales/auth";
import { mysqlDate } from "@reales/database";
import {
  createApiKey, deleteWebhookEndpoint, deliverWebhooks, isNonPublicAddress, listApiKeys, listLeads, listWebhookDeliveries, listWebhookEndpoints, retryWebhookDelivery,
  revokeApiKey, rotateWebhookSecret, saveWebhookEndpoint, sendTestWebhook, validateWebhookUrl, verifySignature, withUow, type WebhookSender,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { contextFor, closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";

const sq = () => testDb();
afterAll(closeTestDb);

const emit = (ctx: any, type: string, payload: object = { n: 1 }) => withUow(sq(), ctx, (u) => u.emit({ type, aggregateType: "lead", aggregateId: randomUUID(), payload }));
const url = () => `https://${uniq("hooks")}.example.com/reales`;
const rows = async (endpointId: string) => sq().query<any>("SELECT * FROM webhook_deliveries WHERE endpoint_id=:e ORDER BY created_at", { replacements: { e: endpointId }, type: QueryTypes.SELECT });

describe("API keys", () => {
  it("creates a key once, authenticates as its creator with only the chosen permissions, and can be revoked", async () => {
    const t = await makeTenant();
    const k = await createApiKey(sq(), t.admin, { name: "Export", scopes: ["lead.read", "contact.read"] });
    expect(k.key).toMatch(/^rk_[0-9a-f]{8}_/);
    const list: any = await listApiKeys(sq(), t.admin);
    expect(JSON.stringify(list)).not.toContain(k.key); // only the prefix is ever shown again
    expect(JSON.stringify(list)).not.toMatch(/keyHash|key_hash/);
    expect(list.keys[0]).toMatchObject({ name: "Export", keyPrefix: k.prefix });

    const ctx = await resolveRequestContext(sq(), k.key, { correlationId: "corr_key_test" });
    expect(ctx).toMatchObject({ tenantId: t.tenantId, userId: t.adminId, stepUpValid: false });
    expect([...new Set(ctx.grants.map((g) => g.permission))].sort()).toEqual(["contact.read", "lead.read"]);
    await expect(listLeads(sq(), ctx, { limit: 5, offset: 0 })).resolves.toBeDefined(); // allowed by the scope
    await expect(createApiKey(sq(), ctx, { name: "Escalate", scopes: ["lead.read"] })).rejects.toBeInstanceOf(ForbiddenError); // a key cannot mint keys

    await revokeApiKey(sq(), t.admin, k.id);
    await expect(resolveRequestContext(sq(), k.key, { correlationId: "corr_key_test" })).rejects.toBeInstanceOf(AuthError);
  });

  it("refuses wrong secrets, expired keys, forbidden scopes and scopes the creator does not hold", async () => {
    const t = await makeTenant();
    await expect(createApiKey(sq(), t.admin, { name: "x", scopes: ["role.manage"] })).rejects.toThrow(/cannot be put on a key/);
    await expect(createApiKey(sq(), t.admin, { name: "x", scopes: ["apikey.manage"] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createApiKey(sq(), t.admin, { name: "x", scopes: [] })).rejects.toThrow(/at least one/);
    await expect(createApiKey(sq(), t.admin, { name: "x", scopes: ["not.a.permission"] })).rejects.toBeInstanceOf(ForbiddenError);

    const k = await createApiKey(sq(), t.admin, { name: "Short", scopes: ["lead.read"] });
    await expect(resolveRequestContext(sq(), `${k.prefix}_${"A".repeat(32)}`, { correlationId: "c" })).rejects.toBeInstanceOf(AuthError); // right prefix, wrong secret
    await expect(resolveRequestContext(sq(), "rk_00000000_" + "B".repeat(32), { correlationId: "c" })).rejects.toBeInstanceOf(AuthError);
    await sq().query("UPDATE api_keys SET expires_at = :e WHERE id = :id", { replacements: { e: mysqlDate(new Date(Date.now() - 60_000)), id: k.id } });
    await expect(resolveRequestContext(sq(), k.key, { correlationId: "c" })).rejects.toBeInstanceOf(AuthError);
  });

  it("needs the permission and a fresh second factor, and keeps one company's keys from another", async () => {
    const t = await makeTenant();
    const agent = await makeUser(t, ["agent"]);
    await expect(createApiKey(sq(), agent.ctx, { name: "x", scopes: ["lead.read"] })).rejects.toBeInstanceOf(ForbiddenError);
    const noStepUp = await contextFor(t.tenantId, t.adminId);
    await expect(createApiKey(sq(), noStepUp, { name: "x", scopes: ["lead.read"] })).rejects.toBeInstanceOf(AuthError);

    const other = await makeTenant();
    const k = await createApiKey(sq(), t.admin, { name: "Mine", scopes: ["lead.read"] });
    expect((await listApiKeys(sq(), other.admin) as any).keys).toHaveLength(0);
    await expect(revokeApiKey(sq(), other.admin, k.id)).rejects.toThrow(/not found/i);
    // the key cannot be bent into another company: its context is always its own company
    expect((await resolveRequestContext(sq(), k.key, { correlationId: "c" })).tenantId).toBe(t.tenantId);
  });

  it("stops working when its creator is disabled", async () => {
    const t = await makeTenant();
    const k = await createApiKey(sq(), t.admin, { name: "x", scopes: ["lead.read"] });
    await sq().query("UPDATE users SET status='disabled' WHERE id=:id", { replacements: { id: t.adminId } });
    await expect(resolveRequestContext(sq(), k.key, { correlationId: "c" })).rejects.toBeInstanceOf(AuthError);
  });
});

describe("webhook destinations", () => {
  it("accepts only public https addresses", () => {
    expect(validateWebhookUrl("https://example.com/hook").hostname).toBe("example.com");
    for (const bad of ["http://example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://192.168.1.2/x", "https://[::1]/x", "https://user:pw@example.com/x", "https://svc.internal/x", "ftp://example.com", "not a url"]) {
      expect(() => validateWebhookUrl(bad), bad).toThrow();
    }
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) expect(isNonPublicAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) expect(isNonPublicAddress(a), a).toBe(false);
  });
});

describe("outbound webhooks", () => {
  it("shows the signing secret once, hides it afterwards, and manages endpoints only with the permission", async () => {
    const t = await makeTenant();
    const made: any = await saveWebhookEndpoint(sq(), t.admin, { name: "CRM sync", url: url(), eventTypes: ["lead.*"] });
    expect(made.secret).toMatch(/^whsec_/);
    expect(JSON.stringify(made.endpoint)).not.toMatch(/secret/i);
    const list = await listWebhookEndpoints(sq(), t.admin);
    expect(JSON.stringify(list)).not.toContain(made.secret);
    const rotated = await rotateWebhookSecret(sq(), t.admin, made.endpoint.id);
    expect(rotated.secret).not.toBe(made.secret);

    const agent = await makeUser(t, ["agent"]);
    await expect(saveWebhookEndpoint(sq(), agent.ctx, { name: "x", url: url(), eventTypes: ["*"] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listWebhookEndpoints(sq(), agent.ctx)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveWebhookEndpoint(sq(), t.admin, { name: "x", url: "http://example.com/x", eventTypes: ["*"] })).rejects.toThrow(/https/);
    await expect(saveWebhookEndpoint(sq(), t.admin, { name: "x", url: url(), eventTypes: ["Lead Created!"] })).rejects.toThrow(/valid event/);

    const other = await makeTenant();
    expect(await listWebhookEndpoints(sq(), other.admin)).toHaveLength(0);
    await expect(deleteWebhookEndpoint(sq(), other.admin, made.endpoint.id)).rejects.toThrow(/not found/i);
  });

  it("queues a delivery only for matching endpoints, in the same transaction as the event", async () => {
    const t = await makeTenant();
    const leads: any = await saveWebhookEndpoint(sq(), t.admin, { name: "Leads", url: url(), eventTypes: ["lead.*"] });
    const exact: any = await saveWebhookEndpoint(sq(), t.admin, { name: "Created", url: url(), eventTypes: ["lead.created"] });
    const deals: any = await saveWebhookEndpoint(sq(), t.admin, { name: "Deals", url: url(), eventTypes: ["deal.*"] });
    const off: any = await saveWebhookEndpoint(sq(), t.admin, { name: "Off", url: url(), eventTypes: ["*"], active: true });
    await saveWebhookEndpoint(sq(), t.admin, { id: off.endpoint.id, name: "Off", url: url(), eventTypes: ["*"], active: false });

    await emit(t.admin, "lead.assigned");
    expect(await rows(leads.endpoint.id)).toHaveLength(1);
    expect(await rows(exact.endpoint.id)).toHaveLength(0);
    expect(await rows(deals.endpoint.id)).toHaveLength(0);
    expect(await rows(off.endpoint.id)).toHaveLength(0);
    await emit(t.admin, "lead.created");
    expect(await rows(exact.endpoint.id)).toHaveLength(1);

    // a rolled-back change must not leak an event to the outside world
    await expect(withUow(sq(), t.admin, async (u) => { await u.emit({ type: "lead.created", aggregateType: "lead", aggregateId: randomUUID(), payload: {} }); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await rows(exact.endpoint.id)).toHaveLength(1);

    // another company's events never reach this company's endpoints
    const other = await makeTenant();
    await emit(other.admin, "lead.created");
    expect(await rows(exact.endpoint.id)).toHaveLength(1);
  });

  it("delivers a signed JSON event and records the result", async () => {
    const t = await makeTenant();
    const target = url();
    const made: any = await saveWebhookEndpoint(sq(), t.admin, { name: "Signed", url: target, eventTypes: ["lead.*"] });
    await emit(t.admin, "lead.created", { name: "Aisha" });
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const send: WebhookSender = async (u, body, headers) => { calls.push({ url: u, body, headers }); return { status: 204 }; };
    const out = await deliverWebhooks(sq(), { send });
    expect(out.delivered).toBeGreaterThanOrEqual(1);
    const mine = calls.filter((c) => c.url === target);
    expect(mine).toHaveLength(1);
    const body = JSON.parse(mine[0]!.body);
    expect(body).toMatchObject({ type: "lead.created", tenantId: t.tenantId, aggregateType: "lead", data: { name: "Aisha" } });
    expect(mine[0]!.headers["x-reales-event"]).toBe("lead.created");
    expect(verifySignature(made.secret, mine[0]!.headers["x-reales-signature"]!, mine[0]!.body)).toBe(true);
    expect(verifySignature(made.secret, mine[0]!.headers["x-reales-signature"]!, mine[0]!.body + " ")).toBe(false); // tampered body
    expect(verifySignature("whsec_wrong", mine[0]!.headers["x-reales-signature"]!, mine[0]!.body)).toBe(false);
    expect(verifySignature(made.secret, mine[0]!.headers["x-reales-signature"]!, mine[0]!.body, 300, Date.now() + 3_600_000)).toBe(false); // replayed an hour later
    const [d] = await rows(made.endpoint.id);
    expect(d).toMatchObject({ status: "delivered", attempts: 1, response_status: 204 });
    // delivered once only
    await deliverWebhooks(sq(), { send });
    expect(calls.filter((c) => c.url === target)).toHaveLength(1);
  });

  it("retries with backoff, gives up after 8 tries, lets a manager retry, and switches a dead endpoint off", async () => {
    const t = await makeTenant();
    const target = url();
    const made: any = await saveWebhookEndpoint(sq(), t.admin, { name: "Flaky", url: target, eventTypes: ["*"] });
    await emit(t.admin, "deal.closed");
    let calls = 0;
    const down: WebhookSender = async (u) => { if (u === target) calls++; return { status: 503 }; };
    const base = Date.now();
    await deliverWebhooks(sq(), { send: down, now: new Date(base) });
    let [d] = await rows(made.endpoint.id);
    expect(d).toMatchObject({ status: "pending", attempts: 1 });
    await deliverWebhooks(sq(), { send: down, now: new Date(base + 1000) }); // too early: backoff not elapsed
    expect(calls).toBe(1);
    for (let i = 1; i <= 8; i++) await deliverWebhooks(sq(), { send: down, now: new Date(base + i * 7 * 3_600_000) });
    [d] = await rows(made.endpoint.id);
    expect(d).toMatchObject({ status: "failed", attempts: 8 });
    expect(calls).toBe(8);
    expect(d.last_error).toContain("503");

    const ok: WebhookSender = async () => ({ status: 200 });
    await retryWebhookDelivery(sq(), t.admin, d.id);
    await deliverWebhooks(sq(), { send: ok, now: new Date(base + 100 * 3_600_000) });
    [d] = await rows(made.endpoint.id);
    expect(d.status).toBe("delivered");
    await expect(retryWebhookDelivery(sq(), t.admin, d.id)).rejects.toThrow(/already succeeded/);

    // 20 failures in a row switch the endpoint off with a reason, and new events are not queued for it
    await sq().query("UPDATE webhook_endpoints SET consecutive_failures = 19 WHERE id = :id", { replacements: { id: made.endpoint.id } });
    await emit(t.admin, "deal.closed");
    await deliverWebhooks(sq(), { send: down, now: new Date(base + 200 * 3_600_000) });
    const [ep] = (await listWebhookEndpoints(sq(), t.admin)) as any[];
    expect(ep).toMatchObject({ active: false });
    expect(ep.disabledReason).toMatch(/20 failed deliveries/);
    const before = (await rows(made.endpoint.id)).length;
    await emit(t.admin, "deal.closed");
    expect((await rows(made.endpoint.id)).length).toBe(before);
    // turning it back on resets the counter
    await saveWebhookEndpoint(sq(), t.admin, { id: made.endpoint.id, name: "Flaky", url: target, eventTypes: ["*"], active: true });
    expect(((await listWebhookEndpoints(sq(), t.admin)) as any[])[0]).toMatchObject({ active: true, consecutiveFailures: 0 });
  });

  it("sends a test event on demand and lists deliveries without payloads", async () => {
    const t = await makeTenant();
    const made: any = await saveWebhookEndpoint(sq(), t.admin, { name: "T", url: url(), eventTypes: ["lead.*"] });
    const res: any = await sendTestWebhook(sq(), t.admin, made.endpoint.id, async () => ({ status: 200 }));
    expect(res).toMatchObject({ eventType: "webhook.test", status: "delivered" });
    const bad: any = await sendTestWebhook(sq(), t.admin, made.endpoint.id, async () => ({ status: null, error: "ECONNREFUSED" }));
    expect(bad).toMatchObject({ status: "failed" });
    expect(bad.lastError).toContain("ECONNREFUSED");
    const list: any[] = await listWebhookDeliveries(sq(), t.admin, made.endpoint.id);
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain("payload");
    const other = await makeTenant();
    await expect(listWebhookDeliveries(sq(), other.admin, made.endpoint.id)).rejects.toThrow(/not found/i);
  });
});
