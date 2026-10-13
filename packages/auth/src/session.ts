import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { loadAccess } from "@reales/rbac";
import { randomToken, safeEqualHex, sha256 } from "./crypto";
import { AuthError } from "./errors";
import { dummyVerify, verifyPassword } from "./password";
import { isMfaEnrolled, verifyMfaCode } from "./mfa";

export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
export const STEP_UP_MS = 10 * 60 * 1000;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const TOUCH_AFTER_MS = 5 * 60 * 1000;

export interface ClientInfo { ip?: string | null; userAgent?: string | null }

export interface LoginResult {
  /** Opaque bearer secret, `<sessionId>.<secret>`. Set as an HttpOnly cookie; never persisted in plain form. */
  token: string;
  sessionId: string;
  status: "ok" | "mfa_required" | "mfa_enrollment_required";
}

async function logLogin(sq: Sequelize, e: { tenantId?: string | null; userId?: string | null; email?: string; outcome: string } & ClientInfo) {
  await sq.query(
    "INSERT INTO login_events (id, tenant_id, user_id, email, outcome, ip, user_agent, created_at) VALUES (UUID(), :tenantId, :userId, :email, :outcome, :ip, :ua, NOW(3))",
    { replacements: { tenantId: e.tenantId ?? null, userId: e.userId ?? null, email: e.email ?? null, outcome: e.outcome, ip: e.ip ?? null, ua: e.userAgent?.slice(0, 255) ?? null } },
  );
}

/** Password login. Errors are deliberately generic so callers cannot enumerate tenants or accounts. */
export async function login(
  sq: Sequelize,
  input: { tenantSlug: string; email: string; password: string } & ClientInfo,
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();
  const [tenant] = await sq.query<{ id: string; status: string }>("SELECT id, status FROM tenants WHERE slug=:slug", {
    replacements: { slug: input.tenantSlug }, type: QueryTypes.SELECT,
  });
  if (!tenant || tenant.status !== "active") {
    await dummyVerify(input.password);
    await logLogin(sq, { ip: input.ip, userAgent: input.userAgent, email, outcome: "unknown_user" });
    throw new AuthError("invalid_credentials");
  }
  const [user] = await sq.query<{ id: string; password_hash: string | null; status: string; failed_login_count: number; locked_until: Date | null }>(
    "SELECT id, password_hash, status, failed_login_count, locked_until FROM users WHERE tenant_id=:t AND normalized_email=:e",
    { replacements: { t: tenant.id, e: email }, type: QueryTypes.SELECT },
  );
  if (!user || !user.password_hash) {
    await dummyVerify(input.password);
    await logLogin(sq, { ip: input.ip, userAgent: input.userAgent, tenantId: tenant.id, email, outcome: "unknown_user" });
    throw new AuthError("invalid_credentials");
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await logLogin(sq, { ip: input.ip, userAgent: input.userAgent, tenantId: tenant.id, userId: user.id, email, outcome: "locked" });
    throw new AuthError("locked", "Account temporarily locked");
  }
  const ok = await verifyPassword(user.password_hash, input.password);
  if (!ok) {
    const failed = user.failed_login_count + 1;
    await sq.query("UPDATE users SET failed_login_count=:f, locked_until=:l WHERE id=:id AND tenant_id=:t", {
      replacements: { f: failed, l: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null, id: user.id, t: tenant.id },
    });
    await logLogin(sq, { ip: input.ip, userAgent: input.userAgent, tenantId: tenant.id, userId: user.id, email, outcome: "bad_password" });
    throw new AuthError("invalid_credentials");
  }
  if (user.status !== "active") {
    await logLogin(sq, { ip: input.ip, userAgent: input.userAgent, tenantId: tenant.id, userId: user.id, email, outcome: "disabled" });
    throw new AuthError("invalid_credentials");
  }
  await sq.query("UPDATE users SET failed_login_count=0, locked_until=NULL, last_login_at=NOW(3) WHERE id=:id AND tenant_id=:t", {
    replacements: { id: user.id, t: tenant.id },
  });

  const enrolled = await isMfaEnrolled(sq, tenant.id, user.id);
  const access = await loadAccess(sq, tenant.id, user.id);
  const status: LoginResult["status"] = enrolled ? "mfa_required" : access.requiresMfa ? "mfa_enrollment_required" : "ok";

  const sessionId = randomUUID();
  const secret = randomToken();
  await sq.query(
    `INSERT INTO sessions (id, tenant_id, user_id, secret_hash, user_agent, ip, expires_at, last_seen_at, mfa_verified_at, created_at, updated_at)
     VALUES (:id, :t, :u, :h, :ua, :ip, :exp, NOW(3), :mfa, NOW(3), NOW(3))`,
    {
      replacements: {
        id: sessionId, t: tenant.id, u: user.id, h: sha256(secret), ua: input.userAgent?.slice(0, 255) ?? null, ip: input.ip ?? null,
        exp: new Date(Date.now() + SESSION_IDLE_MS), mfa: status === "ok" ? new Date() : null,
      },
    },
  );
  await logLogin(sq, { ip: input.ip, userAgent: input.userAgent, tenantId: tenant.id, userId: user.id, email, outcome: status === "ok" ? "success" : "mfa_required" });
  return { token: `${sessionId}.${secret}`, sessionId, status };
}

interface SessionRow {
  id: string; tenant_id: string; user_id: string; secret_hash: string; expires_at: Date; last_seen_at: Date;
  revoked_at: Date | null; mfa_verified_at: Date | null; step_up_until: Date | null; email: string; user_status: string; tenant_status: string;
}

async function loadSession(sq: Sequelize, token: string): Promise<SessionRow> {
  const [sid, secret] = token.split(".");
  if (!sid || !secret || sid.length !== 36) throw new AuthError("session_invalid");
  const [row] = await sq.query<SessionRow>(
    `SELECT s.id, s.tenant_id, s.user_id, s.secret_hash, s.expires_at, s.last_seen_at, s.revoked_at, s.mfa_verified_at, s.step_up_until,
            u.email, u.status AS user_status, t.status AS tenant_status
       FROM sessions s JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id JOIN tenants t ON t.id = s.tenant_id
      WHERE s.id = :sid`,
    { replacements: { sid }, type: QueryTypes.SELECT },
  );
  if (!row || row.revoked_at || new Date(row.expires_at) <= new Date() || !safeEqualHex(row.secret_hash, sha256(secret))) {
    throw new AuthError("session_invalid");
  }
  if (row.user_status !== "active" || row.tenant_status !== "active") throw new AuthError("session_invalid");
  return row;
}

export interface ResolveOptions extends ClientInfo {
  correlationId: string;
  /** Allow a session that has not completed MFA (only the MFA verify/enroll endpoints set this). */
  allowPendingMfa?: boolean;
}

/**
 * Build the RequestContext from the session cookie. This is the ONLY source of tenantId for request handling.
 */
export async function resolveRequestContext(sq: Sequelize, token: string | undefined | null, opts: ResolveOptions): Promise<RequestContext> {
  if (!token) throw new AuthError("session_invalid");
  const s = await loadSession(sq, token);
  const access = await loadAccess(sq, s.tenant_id, s.user_id);
  const enrolled = await isMfaEnrolled(sq, s.tenant_id, s.user_id);
  const needsMfa = enrolled || access.requiresMfa;
  if (needsMfa && !s.mfa_verified_at && !opts.allowPendingMfa) {
    throw new AuthError(enrolled ? "mfa_required" : "mfa_enrollment_required");
  }
  if (Date.now() - new Date(s.last_seen_at).getTime() > TOUCH_AFTER_MS) {
    await sq.query("UPDATE sessions SET last_seen_at=NOW(3), expires_at=:exp WHERE id=:id AND tenant_id=:t", {
      replacements: { exp: new Date(Date.now() + SESSION_IDLE_MS), id: s.id, t: s.tenant_id },
    });
  }
  return {
    tenantId: s.tenant_id, userId: s.user_id, sessionId: s.id, correlationId: opts.correlationId,
    grants: access.grants, membership: access.membership,
    stepUpValid: !!s.step_up_until && new Date(s.step_up_until) > new Date(),
    ip: opts.ip ?? null, userAgent: opts.userAgent ?? null,
  };
}

/** Second factor after password. Marks the session MFA-verified. */
export async function completeMfa(sq: Sequelize, token: string, code: string, client: ClientInfo = {}) {
  const s = await loadSession(sq, token);
  const ok = await verifyMfaCode(sq, s.tenant_id, s.user_id, code);
  if (!ok) {
    await logLogin(sq, { tenantId: s.tenant_id, userId: s.user_id, email: s.email, outcome: "mfa_failed", ip: client.ip, userAgent: client.userAgent });
    throw new AuthError("mfa_invalid");
  }
  await sq.query("UPDATE sessions SET mfa_verified_at=NOW(3) WHERE id=:id AND tenant_id=:t", { replacements: { id: s.id, t: s.tenant_id } });
  await logLogin(sq, { tenantId: s.tenant_id, userId: s.user_id, email: s.email, outcome: "success", ip: client.ip, userAgent: client.userAgent });
}

/** Mark an enrolment-completing session as MFA-verified (called right after confirmTotpEnrollment). */
export async function markSessionMfaVerified(sq: Sequelize, tenantId: string, sessionId: string) {
  await sq.query("UPDATE sessions SET mfa_verified_at=NOW(3) WHERE id=:id AND tenant_id=:t", { replacements: { id: sessionId, t: tenantId } });
}

/** Re-prove the second factor to unlock dangerous actions for STEP_UP_MS. */
export async function performStepUp(sq: Sequelize, ctx: Pick<RequestContext, "tenantId" | "userId" | "sessionId">, code: string) {
  const ok = await verifyMfaCode(sq, ctx.tenantId, ctx.userId, code);
  if (!ok) throw new AuthError("mfa_invalid");
  await sq.query("UPDATE sessions SET step_up_until=:u WHERE id=:id AND tenant_id=:t", {
    replacements: { u: new Date(Date.now() + STEP_UP_MS), id: ctx.sessionId, t: ctx.tenantId },
  });
}

/** Finance exports, API credential changes, bulk deletion, compliance overrides, impersonation, role elevation. */
export function requireStepUp(ctx: Pick<RequestContext, "stepUpValid">) {
  if (!ctx.stepUpValid) throw new AuthError("step_up_required", "Re-verify your second factor to continue");
}

export async function logout(sq: Sequelize, token: string | undefined | null) {
  if (!token) return;
  const [sid] = token.split(".");
  if (sid) await sq.query("UPDATE sessions SET revoked_at=NOW(3) WHERE id=:sid AND revoked_at IS NULL", { replacements: { sid } });
}

export async function revokeAllSessions(sq: Sequelize, tenantId: string, userId: string, exceptSessionId?: string) {
  await sq.query(
    "UPDATE sessions SET revoked_at=NOW(3) WHERE tenant_id=:t AND user_id=:u AND revoked_at IS NULL AND (:ex IS NULL OR id <> :ex)",
    { replacements: { t: tenantId, u: userId, ex: exceptSessionId ?? null } },
  );
}

export async function listSessions(sq: Sequelize, tenantId: string, userId: string) {
  return sq.query(
    "SELECT id, user_agent, ip, last_seen_at, created_at, expires_at FROM sessions WHERE tenant_id=:t AND user_id=:u AND revoked_at IS NULL AND expires_at > NOW(3) ORDER BY last_seen_at DESC",
    { replacements: { t: tenantId, u: userId }, type: QueryTypes.SELECT },
  );
}
