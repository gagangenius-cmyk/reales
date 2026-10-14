import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { QueryTypes } from "sequelize";
import {
  beginSso, completeSso, createChannelAccount, createContact, createInspectionTemplate, createSsoConnection, currentUsage, getUsageSummary, ProviderNotAllowedError, mobileSync,
  mockMessaging, recordConsent, registerDevice, revokeDevice, scheduleInspection, sendMessage, setDataProcessingPolicy, setMonthlyQuota, SsoError, upsertSubprocessor,
  verifyIdToken, type FetchLike,
} from "@reales/domain";
import { login } from "@reales/auth";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, makeUser, PASSWORD, testDb, uniq } from "./helpers";
import { makeInventory, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

afterAll(closeTestDb);
beforeEach(() => mockMessaging.reset());
const sq = () => testDb();

// ---------------------------------------------------------------- a tiny fake OpenID provider
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function signJwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }, key = privateKey) {
  const data = `${b64(header)}.${b64(claims)}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(key).toString("base64url")}`;
}
const ISS = "https://idp.example.test";
const CLIENT = "reales-client";
const base = (nonce: string, over: Record<string, unknown> = {}) => ({ iss: ISS, aud: CLIENT, sub: "u-1", exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce, email_verified: true, ...over });

describe("ID token verification", () => {
  const jwks = { keys: [jwk] };
  const ok = (t: string, nonce = "n1") => verifyIdToken(t, jwks, { issuer: ISS, clientId: CLIENT, nonce });
  it("accepts a valid token and rejects every kind of tampering", () => {
    expect(ok(signJwt(base("n1", { email: "a@x.test" }))).email).toBe("a@x.test");
    expect(() => ok(signJwt(base("n1"), { alg: "none" }))).toThrow(/Only RS256/);
    expect(() => ok(signJwt(base("n1"), { alg: "HS256", kid: "k1" }))).toThrow(/Only RS256/);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(() => ok(signJwt(base("n1"), undefined, other))).toThrow(/signature/);
    const good = signJwt(base("n1"));
    const [h, , s] = good.split(".");
    expect(() => ok(`${h}.${b64(base("n1", { email: "evil@x.test" }))}.${s}`)).toThrow(/signature/);
    expect(() => ok(signJwt(base("n1", { iss: "https://evil.test" })))).toThrow(/issuer/);
    expect(() => ok(signJwt(base("n1", { aud: "someone-else" })))).toThrow(/not issued for this application/);
    expect(() => ok(signJwt(base("n1", { exp: Math.floor(Date.now() / 1000) - 3600 })))).toThrow(/expired/);
    expect(() => ok(signJwt(base("other")))).toThrow(/Nonce/);
    expect(() => ok("a.b")).toThrow(/Malformed/);
    expect(() => verifyIdToken(good, { keys: [{ ...jwk, kid: "other" }] }, { issuer: ISS, clientId: CLIENT, nonce: "n1" })).toThrow(/No matching signing key/);
  });
});

// A fetcher that behaves like the IdP: verifies PKCE and hands back a token for the nonce the app sent.
function idp(session: { nonce: string; challenge: string }, claims: Record<string, unknown>, calls: string[] = []): FetchLike {
  return async (url, init) => {
    calls.push(url);
    if (url.endsWith("/jwks")) return { status: 200, json: async () => ({ keys: [jwk] }) };
    const form = new URLSearchParams(init?.body ?? "");
    const verifierOk = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === session.challenge;
    if (!verifierOk || form.get("code") !== "good-code") return { status: 400, json: async () => ({ error: "invalid_grant" }) };
    return { status: 200, json: async () => ({ id_token: signJwt(base(session.nonce, claims)) }) };
  };
}
const conn = (domain: string, over: Record<string, unknown> = {}) => ({
  name: "Okta", issuer: ISS, clientId: CLIENT, clientSecret: "s3cret", authorizationEndpoint: `${ISS}/authorize`, tokenEndpoint: `${ISS}/token`, jwksUri: `${ISS}/jwks`, emailDomains: [domain], ...over,
});
async function startFlow(tenantSlug: string, email: string) {
  const { authorizationUrl } = await beginSso(sq(), { tenantSlug, email, redirectUri: "https://app.example.test/api/v1/auth/sso/callback" });
  const q = new URL(authorizationUrl).searchParams;
  return { q, state: q.get("state")!, nonce: q.get("nonce")!, challenge: q.get("code_challenge")! };
}

describe("single sign-on (OIDC)", () => {
  it("runs the authorization-code flow with PKCE, signs an existing user in, and the state is single-use", async () => {
    const t = await makeTenant();
    const domain = `${t.slug}.test`;
    await createSsoConnection(sq(), t.admin, conn(domain));
    const f = await startFlow(t.slug, t.adminEmail);
    expect(f.q.get("code_challenge_method")).toBe("S256");
    expect(f.q.get("response_type")).toBe("code");
    const res = await completeSso(sq(), { state: f.state, code: "good-code" }, idp(f, { email: t.adminEmail }));
    expect(res).toMatchObject({ userId: t.adminId, provisioned: false });
    expect(res.status).toBe("mfa_enrollment_required"); // tenant_admin needs MFA and the IdP is not trusted for it
    await expect(completeSso(sq(), { state: f.state, code: "good-code" }, idp(f, { email: t.adminEmail }))).rejects.toThrow(/expired or already used/);
    await expect(completeSso(sq(), { state: "bogus", code: "x" })).rejects.toBeInstanceOf(SsoError);
  });

  it("trusts IdP MFA only when the connection says so", async () => {
    const t = await makeTenant();
    await createSsoConnection(sq(), t.admin, conn(`${t.slug}.test`, { trustIdpMfa: true }));
    const f = await startFlow(t.slug, t.adminEmail);
    expect((await completeSso(sq(), { state: f.state, code: "good-code" }, idp(f, { email: t.adminEmail }))).status).toBe("ok");
  });

  it("rejects failed PKCE/code exchange, unverified or mismatched emails, and foreign domains", async () => {
    const t = await makeTenant();
    await createSsoConnection(sq(), t.admin, conn(`${t.slug}.test`));
    const a = await startFlow(t.slug, t.adminEmail);
    await expect(completeSso(sq(), { state: a.state, code: "wrong" }, idp(a, { email: t.adminEmail }))).rejects.toThrow(/rejected the sign-in/);
    const b = await startFlow(t.slug, t.adminEmail);
    await expect(completeSso(sq(), { state: b.state, code: "good-code" }, idp({ ...b, challenge: "tampered" }, { email: t.adminEmail }))).rejects.toThrow(/rejected the sign-in/);
    const c = await startFlow(t.slug, t.adminEmail);
    await expect(completeSso(sq(), { state: c.state, code: "good-code" }, idp(c, { email: t.adminEmail, email_verified: false }))).rejects.toThrow(/verified email/);
    const d = await startFlow(t.slug, t.adminEmail);
    await expect(completeSso(sq(), { state: d.state, code: "good-code" }, idp(d, { email: `someone.else@${t.slug}.test` }))).rejects.toThrow(/does not match/);
    const e = await startFlow(t.slug, t.adminEmail);
    await expect(completeSso(sq(), { state: e.state, code: "good-code" }, idp(e, { email: "admin@evil.test" }))).rejects.toThrow(/does not match|not allowed/);
    await expect(beginSso(sq(), { tenantSlug: t.slug, email: "x@unknown-domain.test", redirectUri: "https://app.example.test/cb" })).rejects.toThrow(/not available/);
    await expect(beginSso(sq(), { tenantSlug: "no-such-tenant", email: t.adminEmail, redirectUri: "https://app.example.test/cb" })).rejects.toThrow(/not available/);
  });

  it("provisions just-in-time with a non-admin role, refuses admin roles, and never signs in a disabled user", async () => {
    const t = await makeTenant();
    await expect(createSsoConnection(sq(), t.admin, conn(`${t.slug}.test`, { jitEnabled: true, jitRoleKey: "tenant_admin" }))).rejects.toThrow(/non-administrative/);
    await createSsoConnection(sq(), t.admin, conn(`${t.slug}.test`, { jitEnabled: true, jitRoleKey: "agent" }));
    const email = `new.agent@${t.slug}.test`;
    const f = await startFlow(t.slug, email);
    const r = await completeSso(sq(), { state: f.state, code: "good-code" }, idp(f, { email, given_name: "Nadia" }));
    expect(r).toMatchObject({ provisioned: true, status: "ok" });
    const roles = await sq().query<any>("SELECT r.`key` k FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id=:u", { replacements: { u: r.userId }, type: QueryTypes.SELECT });
    expect(roles.map((x) => x.k)).toEqual(["agent"]);
    await sq().query("UPDATE users SET status='disabled' WHERE id=:id", { replacements: { id: r.userId } });
    const g = await startFlow(t.slug, email);
    await expect(completeSso(sq(), { state: g.state, code: "good-code" }, idp(g, { email }))).rejects.toThrow(/disabled/);
  });

  it("without JIT an unknown identity is refused; domains are unique; endpoints must be https; secrets are encrypted", async () => {
    const t = await makeTenant();
    const c: any = await createSsoConnection(sq(), t.admin, conn(`${t.slug}.test`));
    expect(c).not.toHaveProperty("clientSecretEnc");
    expect(c.hasClientSecret).toBe(true);
    const raw = await sq().query<any>("SELECT client_secret_enc FROM sso_connections WHERE id=:id", { replacements: { id: c.id }, type: QueryTypes.SELECT });
    expect(raw[0].client_secret_enc).not.toContain("s3cret");
    await expect(createSsoConnection(sq(), t.admin, conn(`${t.slug}.test`, { name: "Second" }))).rejects.toThrow(/already belongs/);
    await expect(createSsoConnection(sq(), t.admin, conn("other.test", { name: "Insecure", tokenEndpoint: "http://idp.example.test/token" }))).rejects.toThrow(/https/);
    const email = `ghost@${t.slug}.test`;
    const f = await startFlow(t.slug, email);
    await expect(completeSso(sq(), { state: f.state, code: "good-code" }, idp(f, { email }))).rejects.toThrow(/No account exists/);
    const agent = await makeUser(t, ["agent"]);
    await expect(createSsoConnection(sq(), agent.ctx, conn("third.test", { name: "Third" }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("enforced SSO disables password login for the domain", async () => {
    const t = await makeTenant();
    await expect(login(sq(), { tenantSlug: t.slug, email: t.adminEmail, password: PASSWORD })).resolves.toBeTruthy();
    await createSsoConnection(sq(), t.admin, conn(`${t.slug}.test`, { enforce: true }));
    await expect(login(sq(), { tenantSlug: t.slug, email: t.adminEmail, password: PASSWORD })).rejects.toMatchObject({ code: "sso_required" });
  });
});

async function msgKit() {
  const t = await makeTenant();
  await createChannelAccount(sq(), t.admin, { channel: "sms", provider: "mock", name: "sms", identity: "+971400000000" });
  const contact = await createContact(sq(), t.admin, { firstName: "Noor", phone: phone() });
  await recordConsent(sq(), t.admin, { contactId: contact.id, purposeCode: "marketing", channel: "sms", granted: true });
  const send = (key: string) => sendMessage(sq(), t.admin, { contactId: contact.id, channel: "sms", purposeCode: "marketing", body: "Hello", idempotencyKey: key });
  return { t, contact, send };
}

describe("data-processing policy and sub-processors", () => {
  it("restricts nothing by default, then enforces registration, approval and region once a policy exists", async () => {
    const k = await msgKit();
    expect((await k.send("a1")).status).toBe("sent");
    await setDataProcessingPolicy(sq(), k.t.admin, { allowedRegions: ["ae-uae"] });
    await expect(k.send("a2")).rejects.toBeInstanceOf(ProviderNotAllowedError); // not registered
    await expect(upsertSubprocessor(sq(), k.t.admin, { code: "mock", name: "Mock SMS", purpose: "SMS delivery", region: "eu-west", status: "approved" })).rejects.toThrow(/agreement date/);
    await upsertSubprocessor(sq(), k.t.admin, { code: "mock", name: "Mock SMS", purpose: "SMS delivery", region: "eu-west", status: "approved", dpaSignedOn: "2026-01-01" });
    await expect(k.send("a3")).rejects.toThrow(/outside the allowed regions/);
    await setDataProcessingPolicy(sq(), k.t.admin, { allowedRegions: ["ae-uae"], allowCrossBorder: true });
    expect((await k.send("a4")).status).toBe("sent");
    await upsertSubprocessor(sq(), k.t.admin, { code: "mock", name: "Mock SMS", purpose: "SMS delivery", region: "ae-uae", status: "blocked" });
    await expect(k.send("a5")).rejects.toThrow(/blocked by the tenant/);
    await upsertSubprocessor(sq(), k.t.admin, { code: "mock", name: "Mock SMS", purpose: "SMS delivery", region: "ae-uae", status: "approved", dpaSignedOn: "2026-01-01" });
    await setDataProcessingPolicy(sq(), k.t.admin, { allowedRegions: ["ae-uae"] });
    expect((await k.send("a6")).status).toBe("sent");
  });

  it("applies per tenant", async () => {
    const a = await msgKit();
    const b = await msgKit();
    await setDataProcessingPolicy(sq(), a.t.admin, { allowedRegions: ["ae-uae"] });
    await expect(a.send("x1")).rejects.toBeInstanceOf(ProviderNotAllowedError);
    expect((await b.send("x2")).status).toBe("sent");
  });
});

describe("usage metering and quotas", () => {
  it("meters sent messages, blocks at the monthly cap without throwing, and lifts when the cap is raised", async () => {
    const k = await msgKit();
    await setMonthlyQuota(sq(), k.t.admin, "messages_sent", 2);
    expect((await k.send("q1")).status).toBe("sent");
    expect((await k.send("q2")).status).toBe("sent");
    expect(await k.send("q3")).toMatchObject({ status: "blocked", blockedReasons: ["quota_exceeded:messages_sent"] });
    expect(await currentUsage(sq(), k.t.tenantId, "messages_sent")).toBe(2);
    expect((await k.send("q1")).replayed).toBe(true); // a replay of an already-sent message is not a new send
    const sum = await getUsageSummary(sq(), k.t.admin);
    expect(sum.meters).toEqual([{ meter: "messages_sent", used: 2, limit: 2 }]);
    await setMonthlyQuota(sq(), k.t.admin, "messages_sent", 5);
    expect((await k.send("q3")).status).toBe("sent");
    await setMonthlyQuota(sq(), k.t.admin, "messages_sent", null);
    expect((await getUsageSummary(sq(), k.t.admin)).meters[0]).toMatchObject({ used: 3, limit: null });
    const agent = await makeUser(k.t, ["agent"]);
    await expect(setMonthlyQuota(sq(), agent.ctx, "messages_sent", 1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("counts concurrent sends exactly", async () => {
    const k = await msgKit();
    await Promise.all(Array.from({ length: 6 }, (_, i) => k.send(`c${i}`)));
    expect(await currentUsage(sq(), k.t.tenantId, "messages_sent")).toBe(6);
  });
});

describe("mobile devices and offline sync", () => {
  async function field() {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const inspector = await makeUser(t, ["inspector"], { branchId: org.marina.id, businessUnitId: org.bu.id });
    const pm = await makeUser(t, ["property_manager"], { branchId: org.marina.id, businessUnitId: org.bu.id });
    const inv = await makeInventory(t);
    const tpl = await createInspectionTemplate(sq(), pm.ctx, { name: uniq("tpl"), kind: "periodic", items: [{ label: "Walls" }, { label: "Floors" }] });
    const insp = await scheduleInspection(sq(), pm.ctx, { unitId: inv.unit.id, kind: "periodic", inspectorUserId: inspector.id, templateId: tpl.id });
    return { t, inspector, pm, insp };
  }

  it("journals each client mutation once per device, reports conflicts, and refuses revoked devices", async () => {
    const f = await field();
    const dev: any = await registerDevice(sq(), f.inspector.ctx, { deviceId: "phone-1", platform: "android", name: "Pixel" });
    expect(dev.status).toBe("active");
    const [walls] = f.insp.items as any[];
    const batch = [{ clientMutationId: "m1", kind: "inspection.sync" as const, payload: { inspectionId: f.insp.id, mutations: [{ clientMutationId: "i1", baseVersion: 1, changes: [{ itemId: walls.id, condition: "good" as const }] }] } }];
    const first = await mobileSync(sq(), f.inspector.ctx, "phone-1", batch);
    expect(first.results[0]).toMatchObject({ clientMutationId: "m1", status: "applied" });
    const again = await mobileSync(sq(), f.inspector.ctx, "phone-1", batch);
    expect(again.results[0]!.status).toBe("duplicate");

    const stale = await mobileSync(sq(), f.inspector.ctx, "phone-1", [{ clientMutationId: "m2", kind: "inspection.sync", payload: { inspectionId: f.insp.id, mutations: [{ clientMutationId: "i2", baseVersion: 1, changes: [{ itemId: walls.id, condition: "damaged" }] }] } }]);
    expect(stale.results[0]!.status).toBe("conflict");
    const missing = await mobileSync(sq(), f.inspector.ctx, "phone-1", [{ clientMutationId: "m3", kind: "inspection.sync", payload: { inspectionId: "00000000-0000-4000-8000-000000000000", mutations: [] } }]);
    expect(missing.results[0]!.status).toBe("rejected");

    await expect(registerDevice(sq(), f.pm.ctx, { deviceId: "phone-1", platform: "ios" })).rejects.toBeInstanceOf(ForbiddenError); // no mobile.sync for this role
    await revokeDevice(sq(), f.inspector.ctx, dev.id);
    await expect(mobileSync(sq(), f.inspector.ctx, "phone-1", batch)).rejects.toThrow(/revoked/);
    await expect(registerDevice(sq(), f.inspector.ctx, { deviceId: "phone-1", platform: "android" })).rejects.toThrow(/revoked/);
  });

  it("keeps devices private to their owner and to their tenant", async () => {
    const f = await field();
    const dev: any = await registerDevice(sq(), f.inspector.ctx, { deviceId: "phone-9", platform: "ios" });
    const other = await makeUser(f.t, ["inspector"]);
    await expect(registerDevice(sq(), other.ctx, { deviceId: "phone-9", platform: "ios" })).rejects.toThrow(/another user/);
    await expect(revokeDevice(sq(), other.ctx, dev.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(mobileSync(sq(), other.ctx, "phone-9", [])).rejects.toThrow(/not found/i);
    const foreign = await field();
    await expect(mobileSync(sq(), foreign.inspector.ctx, "phone-9", [])).rejects.toThrow(/not found/i);
  });
});
