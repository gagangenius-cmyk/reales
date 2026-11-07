import { describe, expect, it } from "vitest";
import { API_KEY_PATTERN, generateApiKey, isApiKeyToken, sha256 } from "@reales/auth";
import { PERMISSIONS, ROLE_TEMPLATES } from "@reales/rbac";
import { MODULES, cleanFilters, isNonPublicAddress, matchesEvent, retryDelayMs, signPayload, validateWebhookUrl, verifySignature, moduleForApi } from "@reales/domain";
import { apiKeySchema, claimActionSchema, googleSettingsSchema, photoshootActionSchema, savedViewSchema, webhookEndpointSchema } from "@reales/validation";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("API key format", () => {
  it("generates a key that matches the pattern, hashes to its stored value and is unique", () => {
    const a = generateApiKey(), b = generateApiKey();
    expect(API_KEY_PATTERN.test(a.key)).toBe(true);
    expect(a.key.startsWith(a.prefix + "_")).toBe(true);
    expect(a.prefix).toHaveLength(11);
    expect(a.hash).toBe(sha256(a.key));
    expect(a.key).not.toBe(b.key);
    expect(isApiKeyToken(a.key)).toBe(true);
    expect(isApiKeyToken("0b1c2d3e-0000-4000-8000-000000000000.secret")).toBe(false); // an ordinary session token
    expect(isApiKeyToken(undefined)).toBe(false);
  });
  it("rejects malformed keys before touching the database", () => {
    for (const bad of ["rk_", "rk_zzzzzzzz_" + "a".repeat(40), "rk_00000000_short", "rk_00000000_" + "a".repeat(80), "rk_00000000_" + "a b".repeat(20)]) expect(API_KEY_PATTERN.test(bad), bad).toBe(false);
  });
});

describe("webhook safety and signing", () => {
  it("blocks private and metadata addresses", () => {
    for (const a of ["127.0.0.1", "10.0.0.1", "172.20.1.1", "192.168.1.1", "169.254.169.254", "100.100.1.1", "0.0.0.0", "::1", "fc00::1", "fe80::2", "::ffff:127.0.0.1", "239.1.1.1", "not-an-ip"]) expect(isNonPublicAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1", "2001:4860:4860::8888"]) expect(isNonPublicAddress(a), a).toBe(false);
  });
  it("validates destination URLs", () => {
    expect(() => validateWebhookUrl("https://hooks.example.com/a?b=1")).not.toThrow();
    for (const bad of ["http://hooks.example.com", "https://localhost", "https://a.localhost/x", "https://127.1.2.3", "https://[::1]/", "https://u:p@example.com", "https://x.internal", "javascript:alert(1)", ""]) expect(() => validateWebhookUrl(bad), bad).toThrow();
  });
  it("matches event patterns", () => {
    expect(matchesEvent(["*"], "lead.created")).toBe(true);
    expect(matchesEvent(["lead.*"], "lead.created")).toBe(true);
    expect(matchesEvent(["lead.*"], "leadership.created")).toBe(false);
    expect(matchesEvent(["lead.created"], "lead.created")).toBe(true);
    expect(matchesEvent(["lead.created"], "lead.assigned")).toBe(false);
    expect(matchesEvent(["deal.*", "claim.*"], "claim.released")).toBe(true);
    expect(matchesEvent([], "lead.created")).toBe(false);
  });
  it("signs over timestamp and body, and rejects tampering, wrong secrets, malformed headers and stale timestamps", () => {
    const secret = "whsec_test", body = JSON.stringify({ a: 1 }), t = Math.floor(Date.now() / 1000);
    const header = `t=${t},v1=${signPayload(secret, t, body)}`;
    expect(verifySignature(secret, header, body)).toBe(true);
    expect(verifySignature(secret, header, body + "x")).toBe(false);
    expect(verifySignature("whsec_other", header, body)).toBe(false);
    expect(verifySignature(secret, "garbage", body)).toBe(false);
    expect(verifySignature(secret, header, body, 300, Date.now() + 10 * 60_000)).toBe(false);
    expect(verifySignature(secret, `t=${t - 3600},v1=${signPayload(secret, t - 3600, body)}`, body)).toBe(false);
  });
  it("backs off exponentially up to six hours", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(5)).toBe(480_000);
    expect(retryDelayMs(20)).toBe(6 * 3600_000);
  });
});

describe("new permissions and modules", () => {
  it("declares every new permission and only grants known ones", () => {
    for (const p of ["apikey.manage", "webhook.manage", "photoshoot.request", "photoshoot.manage", "google.connect", "claim.read", "claim.create", "claim.verify", "claim.approve", "claim.release", "claim.reverse"]) expect(p in PERMISSIONS, p).toBe(true);
    for (const t of ROLE_TEMPLATES) for (const [p] of t.grants) expect(p in PERMISSIONS, `${t.key}:${p}`).toBe(true);
  });
  it("keeps claim approval and release apart in the shipped roles", () => {
    const has = (role: string, p: string) => ROLE_TEMPLATES.find((r) => r.key === role)!.grants.some(([x]) => x === p);
    expect(has("finance_officer", "claim.create") && has("finance_officer", "claim.verify") && has("finance_officer", "claim.release")).toBe(true);
    expect(has("finance_officer", "claim.approve") || has("finance_officer", "claim.reverse")).toBe(false);
    expect(has("finance_controller", "claim.approve") && has("finance_controller", "claim.reverse")).toBe(true);
    expect(has("finance_controller", "claim.create") || has("finance_controller", "claim.release")).toBe(false);
    expect(has("agent", "apikey.manage") || has("branch_manager", "apikey.manage")).toBe(false);
  });
  it("routes the new APIs to modules the company can switch off", () => {
    expect(moduleForApi("/api/v1/commission-claims/abc")).toBe("claims");
    expect(moduleForApi("/api/v1/photoshoots")).toBe("photoshoots");
    expect(moduleForApi("/api/v1/api-keys")).toBe("integrations");
    expect(moduleForApi("/api/v1/webhook-endpoints/1/test")).toBe("integrations");
    expect(moduleForApi("/api/v1/google/callback")).toBe("google");
    for (const key of ["claims", "photoshoots", "integrations", "google"]) expect(MODULES.some((m) => m.key === key), key).toBe(true);
  });
});

describe("saved view filters", () => {
  it("drops paging, keeps simple filters, refuses odd keys and values", () => {
    expect(cleanFilters({ q: "marina", page: "4", sort: "newest" })).toEqual({ q: "marina", sort: "newest" });
    expect(() => cleanFilters({ "a-b": "1" })).toThrow();
    expect(() => cleanFilters({ q: ["x"] as unknown as string })).toThrow();
  });
});

describe("request validation for the new endpoints", () => {
  it("api keys and webhooks", () => {
    expect(apiKeySchema.safeParse({ name: "x", scopes: ["lead.read"], expiresInDays: 30 }).success).toBe(true);
    expect(apiKeySchema.safeParse({ name: "x", scopes: [] }).success).toBe(false);
    expect(apiKeySchema.safeParse({ name: "x", scopes: ["lead.read"], expiresInDays: 4000 }).success).toBe(false);
    expect(apiKeySchema.safeParse({ name: "x", scopes: ["lead.read"], admin: true }).success).toBe(false); // strict
    expect(webhookEndpointSchema.safeParse({ name: "n", url: "https://example.com/h", eventTypes: ["lead.*"] }).success).toBe(true);
    expect(webhookEndpointSchema.safeParse({ name: "n", url: "https://example.com/h", eventTypes: [] }).success).toBe(false);
  });
  it("photoshoot and claim actions", () => {
    expect(photoshootActionSchema.safeParse({ action: "schedule", scheduledAt: "2026-12-01T10:00:00.000Z", photographerName: "Studio" }).success).toBe(true);
    expect(photoshootActionSchema.safeParse({ action: "schedule", scheduledAt: "tomorrow" }).success).toBe(false);
    expect(photoshootActionSchema.safeParse({ action: "deliver", mediaCount: 0 }).success).toBe(false);
    expect(photoshootActionSchema.safeParse({ action: "explode" }).success).toBe(false);
    expect(claimActionSchema.safeParse({ action: "release", reference: "BANK-1" }).success).toBe(true);
    expect(claimActionSchema.safeParse({ action: "release" }).success).toBe(false);
    expect(claimActionSchema.safeParse({ action: "schedule", date: "2026-11-30" }).success).toBe(true);
    expect(claimActionSchema.safeParse({ action: "schedule", date: "30/11/2026" }).success).toBe(false);
    expect(claimActionSchema.safeParse({ action: "verify_item", itemId: uuid, outcome: "maybe" }).success).toBe(false);
  });
  it("saved views and google settings", () => {
    expect(savedViewSchema.safeParse({ entity: "leads", name: "Hot", filters: { hot: "1" } }).success).toBe(true);
    expect(savedViewSchema.safeParse({ entity: "payroll", name: "Hot", filters: {} }).success).toBe(false);
    expect(savedViewSchema.safeParse({ entity: "leads", name: "Hot", filters: { n: 5 } }).success).toBe(false);
    expect(googleSettingsSchema.safeParse({ syncGmail: true }).success).toBe(true);
    expect(googleSettingsSchema.safeParse({ refreshToken: "steal" }).success).toBe(false);
  });
});
