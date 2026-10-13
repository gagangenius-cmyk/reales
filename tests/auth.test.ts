import { afterAll, describe, expect, it } from "vitest";
import {
  AuthError, beginTotpEnrollment, completeMfa, confirmTotpEnrollment, listSessions, login, logout,
  markSessionMfaVerified, performStepUp, requireStepUp, resolveRequestContext, revokeAllSessions,
} from "@reales/auth";
import { updateUser } from "@reales/domain";
import { closeTestDb, makeTenant, makeUser, PASSWORD, testDb, totpNow } from "./helpers";

afterAll(closeTestDb);

const corr = { correlationId: "corr_test" };
const sq = () => testDb();

describe("login and sessions", () => {
  it("logs in a non-MFA role and resolves tenant context only from the session", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]);
    const r = await login(sq(), { tenantSlug: t.slug, email: u.email, password: PASSWORD });
    expect(r.status).toBe("ok");
    const ctx = await resolveRequestContext(sq(), r.token, corr);
    expect(ctx.tenantId).toBe(t.tenantId);
    expect(ctx.userId).toBe(u.id);
    expect(ctx.grants.some((g) => g.permission === "lead.read" && g.scope === "own_records")).toBe(true);
  });

  it("gives identical generic errors for unknown tenant, unknown user and wrong password", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]);
    const errs = await Promise.all([
      login(sq(), { tenantSlug: "no-such-tenant", email: u.email, password: PASSWORD }).catch((e) => e),
      login(sq(), { tenantSlug: t.slug, email: "ghost@x.test", password: PASSWORD }).catch((e) => e),
      login(sq(), { tenantSlug: t.slug, email: u.email, password: "wrong-Password-1" }).catch((e) => e),
    ]);
    for (const e of errs) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("invalid_credentials");
    }
  });

  it("does not let a user of tenant A sign in to tenant B", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const u = await makeUser(a, ["agent"]);
    await expect(login(sq(), { tenantSlug: b.slug, email: u.email, password: PASSWORD })).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("locks the account after 5 bad passwords, even for the right password afterwards", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]);
    for (let i = 0; i < 5; i++) await login(sq(), { tenantSlug: t.slug, email: u.email, password: "bad-Password-9" }).catch(() => {});
    await expect(login(sq(), { tenantSlug: t.slug, email: u.email, password: PASSWORD })).rejects.toMatchObject({ code: "locked" });
  });

  it("rejects tampered, revoked and disabled-user sessions", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]);
    const r = await login(sq(), { tenantSlug: t.slug, email: u.email, password: PASSWORD });
    const [sid] = r.token.split(".");
    await expect(resolveRequestContext(sq(), `${sid}.forged-secret`, corr)).rejects.toMatchObject({ code: "session_invalid" });
    await expect(resolveRequestContext(sq(), undefined, corr)).rejects.toMatchObject({ code: "session_invalid" });

    const r2 = await login(sq(), { tenantSlug: t.slug, email: u.email, password: PASSWORD });
    await logout(sq(), r2.token);
    await expect(resolveRequestContext(sq(), r2.token, corr)).rejects.toMatchObject({ code: "session_invalid" });

    await updateUser(sq(), t.admin, u.id, { status: "disabled" }); // also revokes sessions
    await expect(resolveRequestContext(sq(), r.token, corr)).rejects.toMatchObject({ code: "session_invalid" });
    expect((await listSessions(sq(), t.tenantId, u.id)).length).toBe(0);
  });

  it("revokeAllSessions keeps only the excepted session", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]);
    const a = await login(sq(), { tenantSlug: t.slug, email: u.email, password: PASSWORD });
    const b = await login(sq(), { tenantSlug: t.slug, email: u.email, password: PASSWORD });
    await revokeAllSessions(sq(), t.tenantId, u.id, b.sessionId);
    await expect(resolveRequestContext(sq(), a.token, corr)).rejects.toMatchObject({ code: "session_invalid" });
    await expect(resolveRequestContext(sq(), b.token, corr)).resolves.toBeTruthy();
  });
});

describe("MFA and step-up", () => {
  it("forces MFA enrolment for privileged roles, then requires the code on next login", async () => {
    const t = await makeTenant();
    const first = await login(sq(), { tenantSlug: t.slug, email: t.adminEmail, password: PASSWORD });
    expect(first.status).toBe("mfa_enrollment_required");
    // Blocked everywhere until enrolment completes
    await expect(resolveRequestContext(sq(), first.token, corr)).rejects.toMatchObject({ code: "mfa_enrollment_required" });
    const pending = await resolveRequestContext(sq(), first.token, { ...corr, allowPendingMfa: true });

    const { secret } = await beginTotpEnrollment(sq(), t.tenantId, t.adminId, t.adminEmail);
    await expect(confirmTotpEnrollment(sq(), t.tenantId, t.adminId, "000000")).rejects.toMatchObject({ code: "mfa_invalid" });
    const { recoveryCodes } = await confirmTotpEnrollment(sq(), t.tenantId, t.adminId, totpNow(secret));
    expect(recoveryCodes).toHaveLength(10);
    await markSessionMfaVerified(sq(), t.tenantId, pending.sessionId);
    await expect(resolveRequestContext(sq(), first.token, corr)).resolves.toBeTruthy();

    // Next login: MFA required. The just-used step is replay-protected, so use the next window's code.
    const second = await login(sq(), { tenantSlug: t.slug, email: t.adminEmail, password: PASSWORD });
    expect(second.status).toBe("mfa_required");
    await expect(resolveRequestContext(sq(), second.token, corr)).rejects.toMatchObject({ code: "mfa_required" });
    await expect(completeMfa(sq(), second.token, totpNow(secret))).rejects.toMatchObject({ code: "mfa_invalid" }); // replay of enrolment step
    await completeMfa(sq(), second.token, totpNow(secret, 1));
    await expect(resolveRequestContext(sq(), second.token, corr)).resolves.toBeTruthy();

    // A TOTP code cannot be used twice
    const third = await login(sq(), { tenantSlug: t.slug, email: t.adminEmail, password: PASSWORD });
    await expect(completeMfa(sq(), third.token, totpNow(secret, 1))).rejects.toMatchObject({ code: "mfa_invalid" });

    // Recovery codes are single use
    await completeMfa(sq(), third.token, recoveryCodes[0]!);
    const fourth = await login(sq(), { tenantSlug: t.slug, email: t.adminEmail, password: PASSWORD });
    await expect(completeMfa(sq(), fourth.token, recoveryCodes[0]!)).rejects.toMatchObject({ code: "mfa_invalid" });
  });

  it("step-up unlocks dangerous actions and requires a fresh code", async () => {
    const t = await makeTenant();
    const { secret } = await beginTotpEnrollment(sq(), t.tenantId, t.adminId, t.adminEmail);
    const { recoveryCodes } = await confirmTotpEnrollment(sq(), t.tenantId, t.adminId, totpNow(secret));
    const s = await login(sq(), { tenantSlug: t.slug, email: t.adminEmail, password: PASSWORD });
    await completeMfa(sq(), s.token, totpNow(secret, 1));
    const ctx = await resolveRequestContext(sq(), s.token, corr);
    expect(() => requireStepUp(ctx)).toThrow(AuthError);
    await expect(performStepUp(sq(), ctx, "123456")).rejects.toMatchObject({ code: "mfa_invalid" });
    // A TOTP step can be used once (replay protection), so step-up here uses a single-use recovery code.
    await performStepUp(sq(), ctx, recoveryCodes[0]!);
    await expect(performStepUp(sq(), ctx, recoveryCodes[0]!)).rejects.toMatchObject({ code: "mfa_invalid" });
    const after = await resolveRequestContext(sq(), s.token, corr);
    expect(() => requireStepUp(after)).not.toThrow();
  });
});
