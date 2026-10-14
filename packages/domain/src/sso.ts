import { createHash, createPublicKey, randomBytes, randomUUID, verify as cryptoVerify } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { decryptField, encryptField, issueSession, type LoginResult, AuthError } from "@reales/auth";
import { mysqlDate, RequestContext, systemContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { plain } from "./scope";
import { assertQuota, ConflictError, NotFoundError, withUow } from "./uow";

/**
 * OpenID Connect, authorization-code flow with PKCE (S256), state and nonce. The ID token is verified here (RS256 only, issuer, audience, expiry,
 * nonce, verified email) against the IdP's published keys; nothing from the token is trusted until all checks pass. SAML is NOT implemented.
 */
export interface FetchLike { (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json(): Promise<any> }> }
const defaultFetch: FetchLike = (url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(8000) }) as any;

const b64u = (b: Buffer) => b.toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const domainOf = (email: string) => email.trim().toLowerCase().split("@")[1] ?? "";
const ELEVATED = new Set(["tenant_admin"]);

export class SsoError extends Error {
  status = 401;
  constructor(public code: string, message?: string) { super(message ?? code); this.name = "SsoError"; }
}

// ---------------------------------------------------------------- id-token verification (pure apart from the key fetch)
export interface IdClaims { iss: string; aud: string | string[]; sub: string; exp: number; iat?: number; nonce?: string; email?: string; email_verified?: boolean; [k: string]: unknown }

export function verifyIdToken(token: string, jwks: { keys: any[] }, expect: { issuer: string; clientId: string; nonce: string; now?: number; skewSec?: number }): IdClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new SsoError("bad_token", "Malformed ID token");
  const [h, p, sig] = parts as [string, string, string];
  let header: any; let claims: IdClaims;
  try { header = JSON.parse(Buffer.from(h, "base64url").toString()); claims = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { throw new SsoError("bad_token", "Malformed ID token"); }
  if (header.alg !== "RS256") throw new SsoError("bad_alg", "Only RS256 ID tokens are accepted"); // never "none", never HMAC with a public key
  const candidates = jwks.keys.filter((k) => k.kty === "RSA" && (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig"));
  if (!candidates.length) throw new SsoError("unknown_key", "No matching signing key");
  const ok = candidates.some((k) => {
    try { return cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: k, format: "jwk" }), Buffer.from(sig, "base64url")); } catch { return false; }
  });
  if (!ok) throw new SsoError("bad_signature", "ID token signature is invalid");
  const now = Math.floor((expect.now ?? Date.now()) / 1000);
  const skew = expect.skewSec ?? 60;
  if (claims.iss !== expect.issuer) throw new SsoError("bad_issuer", "Unexpected token issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expect.clientId)) throw new SsoError("bad_audience", "Token was not issued for this application");
  if (aud.length > 1 && (claims as any).azp !== expect.clientId) throw new SsoError("bad_audience", "Token authorised party mismatch");
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new SsoError("expired", "ID token has expired");
  if (typeof claims.iat === "number" && claims.iat - skew > now) throw new SsoError("bad_iat", "ID token issued in the future");
  if (claims.nonce !== expect.nonce) throw new SsoError("bad_nonce", "Nonce mismatch");
  return claims;
}

// ---------------------------------------------------------------- connection management
export interface SsoConnectionInput {
  name: string; issuer: string; clientId: string; clientSecret?: string; authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string;
  emailDomains: string[]; jitEnabled?: boolean; jitRoleKey?: string; trustIdpMfa?: boolean; enforce?: boolean;
}

const https = (v: string, what: string) => {
  let u: URL;
  try { u = new URL(v); } catch { throw new ConflictError(`${what} must be a valid URL`); }
  if (u.protocol !== "https:") throw new ConflictError(`${what} must use https`);
  return v;
};
const view = (c: any) => { const o = { ...(plain(c) as any) }; delete o.clientSecretEnc; o.hasClientSecret = !!c.get("clientSecretEnc"); return o; };

export async function createSsoConnection(sq: Sequelize, ctx: RequestContext, i: SsoConnectionInput) {
  authorize(ctx, "sso.manage");
  for (const [k, v] of [["issuer", i.issuer], ["authorization endpoint", i.authorizationEndpoint], ["token endpoint", i.tokenEndpoint], ["JWKS URI", i.jwksUri]] as const) https(v, k);
  const domains = [...new Set(i.emailDomains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (!domains.length || domains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw new ConflictError("At least one valid email domain is required");
  if (i.jitEnabled && (!i.jitRoleKey || ELEVATED.has(i.jitRoleKey))) throw new ConflictError("Just-in-time provisioning needs a non-administrative default role");
  return withUow(sq, ctx, async (u) => {
    if (i.jitRoleKey && !(await u.repo("Role").findOne({ where: { key: i.jitRoleKey }, transaction: u.tx }))) throw new NotFoundError("Role");
    // A domain may belong to one connection only, otherwise the sign-in target would be ambiguous.
    for (const c of (await u.repo("SsoConnection").findAll({ where: { status: "active" }, transaction: u.tx })) as any[]) {
      const clash = (c.get("emailDomains") as string[]).find((d) => domains.includes(d));
      if (clash) throw new ConflictError(`The domain ${clash} already belongs to another connection`);
    }
    const c = await u.repo("SsoConnection").create({
      id: randomUUID(), name: i.name, protocol: "oidc", issuer: i.issuer, clientId: i.clientId, clientSecretEnc: i.clientSecret ? encryptField(i.clientSecret) : null,
      authorizationEndpoint: i.authorizationEndpoint, tokenEndpoint: i.tokenEndpoint, jwksUri: i.jwksUri, emailDomains: domains, jitEnabled: !!i.jitEnabled, jitRoleKey: i.jitRoleKey ?? null,
      trustIdpMfa: !!i.trustIdpMfa, enforce: !!i.enforce, status: "active",
    }, { transaction: u.tx });
    await u.audit({ action: "sso.connection_created", entityType: "sso_connection", entityId: (c as any).get("id"), after: { name: i.name, domains, enforce: !!i.enforce, jit: !!i.jitEnabled } });
    return view(c);
  });
}

export async function listSsoConnections(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "sso.manage");
  return withUow(sq, ctx, async (u) => (await u.repo("SsoConnection").findAll({ order: [["name", "ASC"]], transaction: u.tx })).map(view));
}

export async function setSsoConnectionStatus(sq: Sequelize, ctx: RequestContext, id: string, status: "active" | "disabled") {
  authorize(ctx, "sso.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("SsoConnection").findById(id, { transaction: u.tx }))) throw new NotFoundError("SSO connection");
    await u.repo("SsoConnection").updateById(id, { status }, { transaction: u.tx });
    await u.audit({ action: "sso.connection_status", entityType: "sso_connection", entityId: id, after: { status } });
    return view(await u.repo("SsoConnection").findById(id, { transaction: u.tx }));
  });
}

// ---------------------------------------------------------------- sign-in flow
export async function beginSso(sq: Sequelize, i: { tenantSlug: string; email: string; redirectUri: string }): Promise<{ authorizationUrl: string }> {
  const [t] = await sq.query<{ id: string }>("SELECT id FROM tenants WHERE slug=:s AND status='active'", { replacements: { s: i.tenantSlug }, type: QueryTypes.SELECT });
  const generic = new SsoError("sso_unavailable", "Single sign-on is not available for this address");
  if (!t) throw generic;
  const ctx = systemContext(t.id, `corr_${randomUUID()}`);
  return withUow(sq, ctx, async (u) => {
    const d = domainOf(i.email);
    const conns = (await u.repo("SsoConnection").findAll({ where: { status: "active" }, transaction: u.tx })) as any[];
    const c = conns.find((x) => (x.get("emailDomains") as string[]).includes(d));
    if (!c) throw generic;
    const state = b64u(randomBytes(24));
    const nonce = b64u(randomBytes(16));
    const verifier = b64u(randomBytes(32));
    await u.repo("SsoState").create({
      id: randomUUID(), connectionId: c.get("id"), stateHash: sha(state), nonce, codeVerifierEnc: encryptField(verifier), redirectUri: i.redirectUri, loginHint: i.email.trim().toLowerCase(),
      expiresAt: new Date(Date.now() + 10 * 60_000), createdAt: mysqlDate(new Date()),
    }, { transaction: u.tx });
    const q = new URLSearchParams({
      response_type: "code", client_id: c.get("clientId"), redirect_uri: i.redirectUri, scope: "openid email profile", state, nonce,
      code_challenge: b64u(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", login_hint: i.email.trim().toLowerCase(),
    });
    return { authorizationUrl: `${c.get("authorizationEndpoint")}?${q.toString()}` };
  });
}

export async function completeSso(sq: Sequelize, i: { state: string; code: string; ip?: string | null; userAgent?: string | null }, fetcher: FetchLike = defaultFetch): Promise<LoginResult & { tenantId: string; userId: string; provisioned: boolean }> {
  const rows = await sq.query<any>("SELECT * FROM sso_states WHERE state_hash=:h", { replacements: { h: sha(i.state) }, type: QueryTypes.SELECT });
  const st = rows[0];
  if (!st) throw new SsoError("bad_state", "Sign-in request not recognised");
  // One-time use: claim the state atomically before doing anything else, so a replayed callback cannot succeed.
  const [, claimed] = (await sq.query("UPDATE sso_states SET used_at=NOW(3) WHERE id=:id AND tenant_id=:t AND used_at IS NULL AND expires_at > NOW(3)", { replacements: { id: st.id, t: st.tenant_id } })) as any;
  if (!(claimed?.affectedRows ?? claimed)) throw new SsoError("bad_state", "Sign-in request expired or already used");

  const ctx = systemContext(st.tenant_id, `corr_${randomUUID()}`);
  const conn: any = await withUow(sq, ctx, async (u) => u.repo("SsoConnection").findById(st.connection_id, { transaction: u.tx }));
  if (!conn || conn.get("status") !== "active") throw new SsoError("sso_unavailable");
  const body = new URLSearchParams({
    grant_type: "authorization_code", code: i.code, redirect_uri: st.redirect_uri, client_id: conn.get("clientId"), code_verifier: decryptField(st.code_verifier_enc),
    ...(conn.get("clientSecretEnc") ? { client_secret: decryptField(conn.get("clientSecretEnc")) } : {}),
  });
  const tok = await fetcher(conn.get("tokenEndpoint"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() });
  const tj = await tok.json().catch(() => ({}));
  if (tok.status !== 200 || typeof tj.id_token !== "string") throw new SsoError("token_exchange_failed", "The identity provider rejected the sign-in");
  const jw = await fetcher(conn.get("jwksUri"));
  const jwks = await jw.json().catch(() => ({ keys: [] }));
  const claims = verifyIdToken(tj.id_token, jwks, { issuer: conn.get("issuer"), clientId: conn.get("clientId"), nonce: st.nonce });

  const email = String(claims.email ?? "").trim().toLowerCase();
  if (!email || claims.email_verified !== true) throw new SsoError("email_unverified", "The identity provider did not return a verified email address");
  if (!(conn.get("emailDomains") as string[]).includes(domainOf(email))) throw new SsoError("domain_not_allowed", "This email domain is not allowed for the connection");
  if (st.login_hint && st.login_hint !== email) throw new SsoError("identity_mismatch", "The signed-in identity does not match the requested address");

  const { userId, provisioned } = await withUow(sq, ctx, async (u) => {
    const user: any = await u.repo("User").findOne({ where: { normalizedEmail: email }, transaction: u.tx });
    if (user) {
      if (user.get("status") === "disabled") throw new SsoError("account_disabled", "This account is disabled");
      if (user.get("status") === "invited") await u.repo("User").updateById(user.get("id"), { status: "active" }, { transaction: u.tx });
      return { userId: user.get("id") as string, provisioned: false };
    }
    if (!conn.get("jitEnabled") || !conn.get("jitRoleKey")) throw new SsoError("no_account", "No account exists for this identity");
    const role: any = await u.repo("Role").findOne({ where: { key: conn.get("jitRoleKey") }, transaction: u.tx });
    if (!role || ELEVATED.has(role.get("key"))) throw new SsoError("no_account", "Automatic provisioning is not permitted for this role");
    await assertQuota(u, ctx, "users", "users");
    const id = randomUUID();
    await u.repo("User").create({ id, email, normalizedEmail: email, passwordHash: null, status: "active", failedLoginCount: 0 }, { transaction: u.tx });
    await u.repo("UserProfile").create({ userId: id, firstName: typeof claims.given_name === "string" ? claims.given_name : null, lastName: typeof claims.family_name === "string" ? claims.family_name : null, locale: "en", timezone: "Asia/Dubai" }, { transaction: u.tx });
    await u.repo("UserRole").create({ userId: id, roleId: role.get("id") }, { transaction: u.tx });
    await u.audit({ action: "user.provisioned_sso", entityType: "user", entityId: id, after: { email, role: role.get("key"), connection: conn.get("name") } });
    return { userId: id, provisioned: true };
  });
  const session = await issueSession(sq, { tenantId: st.tenant_id, userId, email, mfaVerified: !!conn.get("trustIdpMfa"), ip: i.ip, userAgent: i.userAgent });
  return { ...session, tenantId: st.tenant_id, userId, provisioned };
}

void Op; void AuthError;
