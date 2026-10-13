import { afterAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { totpNow, closeTestDb, makeTenant, makeUser, PASSWORD, testDb, uniq } from "./helpers";
import { POST as loginRoute } from "@/app/api/v1/auth/login/route";
import { POST as logoutRoute } from "@/app/api/v1/auth/logout/route";
import { GET as meRoute } from "@/app/api/v1/auth/me/route";
import { POST as enrollRoute } from "@/app/api/v1/auth/mfa/enroll/route";
import { POST as enrollConfirmRoute } from "@/app/api/v1/auth/mfa/enroll/confirm/route";
import { POST as mfaVerifyRoute } from "@/app/api/v1/auth/mfa/verify/route";
import { GET as usersGet, POST as usersPost } from "@/app/api/v1/users/route";
import { PATCH as userPatch } from "@/app/api/v1/users/[id]/route";
import { GET as projectsGet, POST as projectsPost } from "@/app/api/v1/projects/route";
import { GET as auditGet } from "@/app/api/v1/audit-events/route";
import { GET as healthGet } from "@/app/api/v1/health/route";

afterAll(closeTestDb);

const ORIGIN = "http://localhost:3000";

interface CallOpts { body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string>; params?: Record<string, string> }
async function call(handler: (r: NextRequest, c?: any) => Promise<Response>, method: string, path: string, o: CallOpts = {}) {
  const headers: Record<string, string> = { host: "localhost:3000", "content-type": "application/json", ...(o.headers ?? {}) };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.cookie) headers.cookie = `reales_session=${o.cookie}`;
  const req = new NextRequest(`${ORIGIN}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const res = await handler(req, { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, res };
}

const sessionOf = (res: Response) => /reales_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

async function loginAs(slug: string, email: string, password = PASSWORD) {
  const r = await call(loginRoute, "POST", "/api/v1/auth/login", { body: { tenant: slug, email, password } });
  return { ...r, token: sessionOf(r.res) };
}

describe("API: authentication", () => {
  it("logs in with an HttpOnly SameSite cookie and serves /me", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]);
    const r = await loginAs(t.slug, u.email);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("ok");
    const cookie = r.res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    const me = await call(meRoute, "GET", "/api/v1/auth/me", { cookie: r.token });
    expect(me.status).toBe(200);
    expect(me.json.tenant.id).toBe(t.tenantId);
    expect(me.json.permissions).toContain("lead.read");
    expect(me.res.headers.get("x-correlation-id")).toMatch(/^corr_/);
  });

  it("returns 401 without a session and a generic 401 for bad credentials", async () => {
    const t = await makeTenant();
    expect((await call(usersGet, "GET", "/api/v1/users")).status).toBe(401);
    const bad = await loginAs(t.slug, "nobody@x.test", "Wrong-Passw0rd!");
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe("invalid_credentials");
    expect(bad.res.headers.get("set-cookie")).toBeNull();
  });

  it("validates input with 400 and structured issues", async () => {
    const r = await call(loginRoute, "POST", "/api/v1/auth/login", { body: { tenant: "Bad Slug!", email: "not-an-email" } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_error");
    expect(r.json.error.issues.length).toBeGreaterThan(0);
  });

  it("logout revokes the session", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]);
    const { token } = await loginAs(t.slug, u.email);
    const out = await call(logoutRoute, "POST", "/api/v1/auth/logout", { cookie: token });
    expect(out.status).toBe(200);
    expect(out.res.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect((await call(meRoute, "GET", "/api/v1/auth/me", { cookie: token })).status).toBe(401);
  });
});

describe("API: CSRF / origin protection", () => {
  it("rejects state-changing requests without a matching Origin, even with a valid session", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]);
    const { token } = await loginAs(t.slug, u.email);
    const evil = await call(logoutRoute, "POST", "/api/v1/auth/logout", { cookie: token, origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const none = await call(logoutRoute, "POST", "/api/v1/auth/logout", { cookie: token, origin: null });
    expect(none.status).toBe(403);
    expect((await call(meRoute, "GET", "/api/v1/auth/me", { cookie: token })).status).toBe(200); // session survived
  });
});

describe("API: MFA-gated privileged accounts", () => {
  it("blocks the admin until MFA is enrolled, then enforces the second factor", async () => {
    const t = await makeTenant();
    const l = await loginAs(t.slug, t.adminEmail);
    expect(l.json.status).toBe("mfa_enrollment_required");
    const blocked = await call(usersGet, "GET", "/api/v1/users", { cookie: l.token });
    expect(blocked.status).toBe(401);
    expect(blocked.json.error.code).toBe("mfa_enrollment_required");

    const enroll = await call(enrollRoute, "POST", "/api/v1/auth/mfa/enroll", { cookie: l.token });
    expect(enroll.status).toBe(200);
    expect(enroll.json.qrSvg).toContain("<svg");
    expect(enroll.json.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect((await call(enrollConfirmRoute, "POST", "/api/v1/auth/mfa/enroll/confirm", { cookie: l.token, body: { code: "000000" } })).status).toBe(401);
    const confirm = await call(enrollConfirmRoute, "POST", "/api/v1/auth/mfa/enroll/confirm", { cookie: l.token, body: { code: totpNow(enroll.json.secret) } });
    expect(confirm.status).toBe(200);
    expect(confirm.json.recoveryCodes).toHaveLength(10);
    expect((await call(usersGet, "GET", "/api/v1/users", { cookie: l.token })).status).toBe(200);

    // A second password login must present the second factor
    const l2 = await loginAs(t.slug, t.adminEmail);
    expect(l2.json.status).toBe("mfa_required");
    expect((await call(usersGet, "GET", "/api/v1/users", { cookie: l2.token })).json.error.code).toBe("mfa_required");
    expect((await call(mfaVerifyRoute, "POST", "/api/v1/auth/mfa/verify", { cookie: l2.token, body: { code: "123456" } })).status).toBe(401);
    expect((await call(mfaVerifyRoute, "POST", "/api/v1/auth/mfa/verify", { cookie: l2.token, body: { code: totpNow(enroll.json.secret, 1) } })).status).toBe(200);
    expect((await call(usersGet, "GET", "/api/v1/users", { cookie: l2.token })).status).toBe(200);

    // An enrolled user with only a password session cannot replace the second factor
    const l3 = await loginAs(t.slug, t.adminEmail);
    expect((await call(enrollRoute, "POST", "/api/v1/auth/mfa/enroll", { cookie: l3.token })).status).toBe(403);
  });
});

describe("API: authorization and tenant isolation", () => {
  it("returns 403 when the permission is missing and never leaks another tenant's data", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const aViewer = await makeUser(a, ["viewer"]);
    const aAgent = await makeUser(a, ["agent"]);
    const bAgent = await makeUser(b, ["agent"]);
    const viewer = await loginAs(a.slug, aViewer.email);
    expect((await call(projectsPost, "POST", "/api/v1/projects", { cookie: viewer.token, body: { code: "NOPE", name: "n" } })).status).toBe(403);
    expect((await call(projectsGet, "GET", "/api/v1/projects", { cookie: viewer.token })).status).toBe(200);

    // A tenant-B user, fully authenticated, targets a tenant-A user by id: indistinguishable from not found
    const bSession = await loginAs(b.slug, bAgent.email);
    const foreign = await call(userPatch, "PATCH", `/api/v1/users/${aAgent.id}`, { cookie: bSession.token, body: { status: "disabled" }, params: { id: aAgent.id } });
    expect([403, 404]).toContain(foreign.status);
    const aAgentStill = await loginAs(a.slug, aAgent.email);
    expect(aAgentStill.status).toBe(200);
  });

  it("does not accept a tenant id from the request body or headers", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const u = await makeUser(a, ["viewer"]);
    const { token } = await loginAs(a.slug, u.email);
    const r = await call(projectsGet, "GET", `/api/v1/projects?tenantId=${b.tenantId}`, { cookie: token, headers: { "x-tenant-id": b.tenantId } });
    expect(r.status).toBe(200);
    expect(r.json.projects).toEqual([]);
  });
});

describe("API: idempotent creation and audit", () => {
  it("replays the same response for a repeated Idempotency-Key and creates one row", async () => {
    const t = await makeTenant();
    // Admin needs MFA; enrol once and reuse a fully verified session
    const l = await loginAs(t.slug, t.adminEmail);
    const enroll = await call(enrollRoute, "POST", "/api/v1/auth/mfa/enroll", { cookie: l.token });
    await call(enrollConfirmRoute, "POST", "/api/v1/auth/mfa/enroll/confirm", { cookie: l.token, body: { code: totpNow(enroll.json.secret) } });

    const key = uniq("idem");
    const code = uniq("P").toUpperCase().slice(0, 12);
    const first = await call(projectsPost, "POST", "/api/v1/projects", { cookie: l.token, headers: { "idempotency-key": key }, body: { code, name: "Once" } });
    const second = await call(projectsPost, "POST", "/api/v1/projects", { cookie: l.token, headers: { "idempotency-key": key }, body: { code, name: "Once" } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.res.headers.get("idempotent-replayed")).toBe("true");
    expect(second.json.id).toBe(first.json.id);
    const mismatch = await call(projectsPost, "POST", "/api/v1/projects", { cookie: l.token, headers: { "idempotency-key": key }, body: { code, name: "Different" } });
    expect(mismatch.status).toBe(422);

    const list = await call(projectsGet, "GET", "/api/v1/projects", { cookie: l.token });
    expect(list.json.projects.filter((p: any) => p.code === code)).toHaveLength(1);

    const audit = await call(auditGet, "GET", "/api/v1/audit-events?limit=20", { cookie: l.token });
    expect(audit.json.events.map((e: any) => e.action)).toContain("project.created");
    expect(audit.json.events.some((e: any) => e.action === "mfa.enrolled")).toBe(true);
  });
});

describe("API: health", () => {
  it("reports database health without auth", async () => {
    const r = await call(healthGet, "GET", "/api/v1/health", { origin: null });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("ok");
    void testDb;
  });
});
