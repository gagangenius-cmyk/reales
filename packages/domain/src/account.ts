import { createHash, randomBytes, randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { assertPasswordPolicy, hashPassword, revokeAllSessions } from "@reales/auth";
import { mysqlDate, RequestContext, systemContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { escapeMailHtml, sendMailSafely } from "./mailer";
import { createUser, CreateUserInput } from "./users";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

const RESET_TTL_MS = 60 * 60_000; // 1 hour
const INVITE_TTL_MS = 7 * 24 * 3_600_000;
const RESEND_COOLDOWN_MS = 60_000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

export class TokenError extends Error {
  status = 400;
  constructor(message = "This link is invalid or has expired") { super(message); this.name = "TokenError"; }
}

async function issueToken(u: Uow, userId: string, kind: "password_reset" | "invite", ttlMs: number): Promise<string> {
  // A newer link replaces older unused ones, so only the latest e-mail works.
  await u.sq.query("UPDATE auth_tokens SET used_at=NOW(3) WHERE tenant_id=:t AND user_id=:u AND kind=:k AND used_at IS NULL", { replacements: { t: u.tenantId, u: userId, k: kind }, transaction: u.tx });
  const token = newToken();
  await u.repo("AuthToken").create({ id: randomUUID(), userId, kind, tokenHash: sha(token), expiresAt: new Date(Date.now() + ttlMs), createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
  return token;
}

const link = (base: string, path: string, token: string) => `${base.replace(/\/$/, "")}${path}?token=${encodeURIComponent(token)}`;

// ---------------------------------------------------------------- forgot / reset password
/**
 * Always resolves with no information: the caller cannot tell whether the address exists, is disabled, or is under enforced SSO.
 * Throttled per user (one e-mail a minute) on top of the per-IP limit at the API.
 */
export async function requestPasswordReset(sq: Sequelize, i: { tenantSlug: string; email: string; baseUrl: string }): Promise<void> {
  const [t] = await sq.query<{ id: string }>("SELECT id FROM tenants WHERE slug=:s AND status='active'", { replacements: { s: i.tenantSlug }, type: QueryTypes.SELECT });
  if (!t) return;
  const email = i.email.trim().toLowerCase();
  const ctx = systemContext(t.id, `corr_${randomUUID()}`);
  const mail = await withUow(sq, ctx, async (u) => {
    const user: any = await u.repo("User").findOne({ where: { normalizedEmail: email }, transaction: u.tx });
    if (!user || user.get("status") !== "active") return null;
    const enforced = await u.sq.query<{ n: number }>("SELECT COUNT(*) n FROM sso_connections WHERE tenant_id=:t AND enforce=1 AND status='active' AND JSON_CONTAINS(email_domains, JSON_QUOTE(:d))", { replacements: { t: t.id, d: email.split("@")[1] ?? "" }, transaction: u.tx, type: QueryTypes.SELECT });
    if (Number(enforced[0]?.n ?? 0) > 0) return null;
    const recent = await u.repo("AuthToken").findOne({ where: { userId: user.get("id"), kind: "password_reset" }, order: [["createdAt", "DESC"]], transaction: u.tx });
    if (recent && Date.now() - new Date(recent.get("createdAt") as string).getTime() < RESEND_COOLDOWN_MS) return null;
    const token = await issueToken(u, user.get("id"), "password_reset", RESET_TTL_MS);
    await u.audit({ action: "user.password_reset_requested", entityType: "user", entityId: user.get("id") });
    return { to: user.get("email") as string, url: link(i.baseUrl, "/reset-password", token) };
  });
  if (!mail) return;
  await sendMailSafely({
    to: mail.to, subject: "Reset your Reales CRM password",
    text: `Someone asked to reset the password for this account.\n\nReset it here (valid for 1 hour, one use):\n${mail.url}\n\nIf this was not you, ignore this email: your password has not changed.`,
    html: `<p>Someone asked to reset the password for this account.</p><p><a href="${escapeMailHtml(mail.url)}">Reset your password</a> (valid for 1 hour, one use).</p><p>If this was not you, ignore this email: your password has not changed.</p>`,
  });
}

async function consume(u: Uow, token: string, kind: "password_reset" | "invite") {
  const row: any = (await u.sq.query<any>("SELECT id, tenant_id, user_id, expires_at FROM auth_tokens WHERE token_hash=:h AND kind=:k AND used_at IS NULL", { replacements: { h: sha(token), k: kind }, transaction: u.tx, type: QueryTypes.SELECT }))[0];
  if (!row || new Date(row.expires_at) <= new Date()) throw new TokenError();
  const [, claimed] = (await u.sq.query("UPDATE auth_tokens SET used_at=NOW(3) WHERE id=:id AND tenant_id=:t AND used_at IS NULL", { replacements: { id: row.id, t: row.tenant_id }, transaction: u.tx })) as any;
  if (!(claimed?.affectedRows ?? claimed)) throw new TokenError();
  return { tenantId: row.tenant_id as string, userId: row.user_id as string };
}

/** The token is single-use; on success every existing session of the user is revoked and the failed-login lock is cleared. */
export async function resetPassword(sq: Sequelize, i: { token: string; password: string }): Promise<void> {
  assertPasswordPolicy(i.password);
  const hash = await hashPassword(i.password);
  const [row] = await sq.query<{ tenant_id: string }>("SELECT tenant_id FROM auth_tokens WHERE token_hash=:h AND kind='password_reset'", { replacements: { h: sha(i.token) }, type: QueryTypes.SELECT });
  if (!row) throw new TokenError();
  const ctx = systemContext(row.tenant_id, `corr_${randomUUID()}`);
  const userId = await withUow(sq, ctx, async (u) => {
    const t = await consume(u, i.token, "password_reset");
    const user: any = await u.repo("User").findById(t.userId, { transaction: u.tx });
    if (!user || user.get("status") !== "active") throw new TokenError();
    await u.repo("User").updateById(t.userId, { passwordHash: hash, failedLoginCount: 0, lockedUntil: null }, { transaction: u.tx });
    await u.audit({ action: "user.password_reset", entityType: "user", entityId: t.userId });
    return t.userId;
  });
  await revokeAllSessions(sq, row.tenant_id, userId);
}

// ---------------------------------------------------------------- invitations
export async function sendInvite(sq: Sequelize, ctx: RequestContext, userId: string, baseUrl: string) {
  const mail = await withUow(sq, ctx, async (u) => {
    const user: any = await u.repo("User").findById(userId, { transaction: u.tx });
    if (!user) throw new NotFoundError("User");
    if (user.get("status") !== "invited") throw new ConflictError("Only an invited user can receive an invitation");
    const [t] = await u.sq.query<{ name: string }>("SELECT name FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    const token = await issueToken(u, userId, "invite", INVITE_TTL_MS);
    await u.audit({ action: "user.invite_sent", entityType: "user", entityId: userId });
    return { to: user.get("email") as string, org: t?.name ?? "your organisation", url: link(baseUrl, "/accept-invite", token) };
  });
  const delivered = await sendMailSafely({
    to: mail.to, subject: `You have been invited to ${mail.org} on Reales CRM`,
    text: `You have been invited to ${mail.org}.\n\nSet your password and sign in (valid for 7 days):\n${mail.url}`,
    html: `<p>You have been invited to <strong>${escapeMailHtml(mail.org)}</strong>.</p><p><a href="${escapeMailHtml(mail.url)}">Set your password and sign in</a> (valid for 7 days).</p>`,
  });
  return { userId, delivered };
}

export async function inviteUser(sq: Sequelize, ctx: RequestContext, input: Omit<CreateUserInput, "password"> & { baseUrl: string }) {
  authorize(ctx, "user.create");
  const { baseUrl, ...rest } = input;
  const user = await createUser(sq, ctx, { ...rest, password: undefined });
  return { user, ...(await sendInvite(sq, ctx, user.id as string, baseUrl)) };
}

export async function resendInvite(sq: Sequelize, ctx: RequestContext, userId: string, baseUrl: string) {
  authorize(ctx, "user.create");
  return sendInvite(sq, ctx, userId, baseUrl);
}

export async function acceptInvite(sq: Sequelize, i: { token: string; password: string }): Promise<{ email: string }> {
  assertPasswordPolicy(i.password);
  const hash = await hashPassword(i.password);
  const [row] = await sq.query<{ tenant_id: string }>("SELECT tenant_id FROM auth_tokens WHERE token_hash=:h AND kind='invite'", { replacements: { h: sha(i.token) }, type: QueryTypes.SELECT });
  if (!row) throw new TokenError();
  const ctx = systemContext(row.tenant_id, `corr_${randomUUID()}`);
  return withUow(sq, ctx, async (u) => {
    const t = await consume(u, i.token, "invite");
    const user: any = await u.repo("User").findById(t.userId, { transaction: u.tx });
    if (!user || user.get("status") !== "invited") throw new TokenError();
    await u.repo("User").updateById(t.userId, { passwordHash: hash, status: "active", failedLoginCount: 0 }, { transaction: u.tx });
    await u.audit({ action: "user.invite_accepted", entityType: "user", entityId: t.userId });
    return { email: user.get("email") as string };
  });
}
