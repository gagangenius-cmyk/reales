import { randomUUID } from "node:crypto";
import { Sequelize } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { generateApiKey, isApiKeyContext, requireStepUp } from "@reales/auth";
import { ForbiddenError, PERMISSIONS, authorize } from "@reales/rbac";
import { plain } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

/** Permissions a machine credential can never carry, whatever its creator holds. */
export const API_KEY_FORBIDDEN_SCOPES = new Set(["apikey.manage", "webhook.manage", "role.manage", "tenant.manage", "session.manage", "sso.manage", "quota.manage", "hr.salary", "user.create"]);
const MAX_ACTIVE_KEYS = 25;
const MAX_DAYS = 365;

const humanOnly = (ctx: RequestContext) => { if (isApiKeyContext(ctx)) throw new ForbiddenError("API keys cannot manage API keys or webhooks"); };

/** Permissions this person may put on a key: ones they hold themselves, minus the forbidden set. */
export function grantableScopes(ctx: Pick<RequestContext, "grants">): string[] {
  return [...new Set(ctx.grants.map((g) => g.permission))].filter((p) => p in PERMISSIONS && !API_KEY_FORBIDDEN_SCOPES.has(p)).sort();
}

export interface ApiKeyInput { name: string; scopes: string[]; expiresInDays?: number }

/** The full key is returned ONCE here; only its hash is stored. Creating one needs a fresh second factor. */
export async function createApiKey(sq: Sequelize, ctx: RequestContext, i: ApiKeyInput) {
  authorize(ctx, "apikey.manage");
  humanOnly(ctx);
  requireStepUp(ctx);
  const name = i.name.trim();
  if (!name) throw new ConflictError("Give the key a name");
  const scopes = [...new Set(i.scopes)];
  if (!scopes.length) throw new ConflictError("Choose at least one permission for the key");
  const allowed = new Set(grantableScopes(ctx));
  const bad = scopes.filter((s) => !allowed.has(s));
  if (bad.length) throw new ForbiddenError(`These permissions cannot be put on a key: ${bad.join(", ")}`);
  const days = Math.min(Math.max(Math.trunc(i.expiresInDays ?? 90), 1), MAX_DAYS);
  return withUow(sq, ctx, async (u) => {
    const active = await u.repo("ApiKey").count({ where: { revokedAt: null }, transaction: u.tx });
    if (active >= MAX_ACTIVE_KEYS) throw new ConflictError(`At most ${MAX_ACTIVE_KEYS} active keys; revoke one first`);
    const k = generateApiKey();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    await u.repo("ApiKey").create({ id, name: name.slice(0, 120), keyPrefix: k.prefix, keyHash: k.hash, scopes, createdBy: ctx.userId, expiresAt: mysqlDate(expiresAt) }, { transaction: u.tx });
    await u.audit({ action: "api_key.created", entityType: "api_key", entityId: id, after: { name, scopes, expiresAt: expiresAt.toISOString() } });
    return { id, name, prefix: k.prefix, key: k.key, scopes, expiresAt: expiresAt.toISOString() };
  });
}

export async function listApiKeys(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "apikey.manage");
  humanOnly(ctx);
  return withUow(sq, ctx, async (u) => {
    const rows = (await u.repo("ApiKey").findAll({ order: [["createdAt", "DESC"]], limit: 200, transaction: u.tx })) as any[];
    return { keys: rows.map((r) => { const { keyHash: _h, ...rest } = plain(r); return rest; }), availableScopes: grantableScopes(ctx) };
  });
}

export async function revokeApiKey(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "apikey.manage");
  humanOnly(ctx);
  return withUow(sq, ctx, async (u) => {
    const k: any = await u.repo("ApiKey").findById(id, { transaction: u.tx });
    if (!k) throw new NotFoundError("API key");
    if (k.get("revokedAt")) return;
    await u.repo("ApiKey").updateById(id, { revokedAt: new Date(), revokedBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: "api_key.revoked", entityType: "api_key", entityId: id, after: { name: k.get("name") } });
  });
}
