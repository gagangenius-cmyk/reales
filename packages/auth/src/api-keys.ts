import { randomBytes } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { loadAccess } from "@reales/rbac";
import { randomToken, safeEqualHex, sha256 } from "./crypto";
import { AuthError } from "./errors";

/** API keys look like `rk_<8 hex>_<secret>`. Only the sha256 of the whole key is stored; the prefix finds the row. */
export const API_KEY_PATTERN = /^rk_[0-9a-f]{8}_[A-Za-z0-9_-]{32,64}$/;
export const isApiKeyToken = (t: string | null | undefined): t is string => !!t && t.startsWith("rk_");
/** Marks a context built from an API key (not a person at a keyboard). Used to refuse key management, step-up and similar human-only actions. */
export const API_KEY_SESSION_PREFIX = "apikey:";
export const isApiKeyContext = (ctx: Pick<RequestContext, "sessionId">) => ctx.sessionId.startsWith(API_KEY_SESSION_PREFIX);

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = `rk_${randomBytes(4).toString("hex")}`;
  const key = `${prefix}_${randomToken(24)}`;
  return { key, prefix, hash: sha256(key) };
}

interface KeyRow { id: string; tenant_id: string; created_by: string; key_hash: string; scopes: string | string[]; expires_at: Date | null; revoked_at: Date | null; last_used_at: Date | null; user_status: string; tenant_status: string }

/**
 * Build a RequestContext from an API key: the key acts as the user who created it, but only with the permissions listed in its scopes
 * (never more than that user still holds). No second factor is involved, so step-up is never valid and key/webhook management is refused.
 */
export async function resolveApiKeyContext(sq: Sequelize, token: string, opts: { correlationId: string; ip?: string | null; userAgent?: string | null }): Promise<RequestContext> {
  if (!API_KEY_PATTERN.test(token)) throw new AuthError("session_invalid");
  const prefix = token.slice(0, 11);
  const [row] = await sq.query<KeyRow>(
    `SELECT k.id, k.tenant_id, k.created_by, k.key_hash, k.scopes, k.expires_at, k.revoked_at, k.last_used_at, u.status AS user_status, t.status AS tenant_status
       FROM api_keys k JOIN users u ON u.id = k.created_by AND u.tenant_id = k.tenant_id JOIN tenants t ON t.id = k.tenant_id WHERE k.key_prefix = :p`,
    { replacements: { p: prefix }, type: QueryTypes.SELECT },
  );
  if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) <= new Date()) || !safeEqualHex(row.key_hash, sha256(token))) throw new AuthError("session_invalid");
  if (row.user_status !== "active" || row.tenant_status !== "active") throw new AuthError("session_invalid");
  const scopes = new Set<string>(typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes);
  const access = await loadAccess(sq, row.tenant_id, row.created_by);
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    await sq.query("UPDATE api_keys SET last_used_at = NOW(3) WHERE id = :id AND tenant_id = :t", { replacements: { id: row.id, t: row.tenant_id } });
  }
  return {
    tenantId: row.tenant_id, userId: row.created_by, sessionId: `${API_KEY_SESSION_PREFIX}${row.id}`, correlationId: opts.correlationId,
    grants: access.grants.filter((g) => scopes.has(g.permission)), membership: access.membership, stepUpValid: false, ip: opts.ip ?? null, userAgent: opts.userAgent ?? null,
  };
}
