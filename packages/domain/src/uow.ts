import { QueryTypes, Sequelize, Transaction } from "sequelize";
import { initModels, Models, recordAudit, AuditInput, repo, RequestContext } from "@reales/database";
import { ForbiddenError } from "@reales/rbac";
import { emitEvent, EmitInput } from "@reales/events";

type Ctx = Pick<RequestContext, "tenantId" | "userId" | "correlationId" | "ip">;

export class NotFoundError extends Error {
  status = 404;
  constructor(what = "Resource") {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class QuotaExceededError extends Error {
  status = 402;
  constructor(public quota: string, public limit: number) {
    super(`Quota exceeded: ${quota} (limit ${limit})`);
    this.name = "QuotaExceededError";
  }
}

export interface Uow {
  tx: Transaction;
  models: Models;
  sq: Sequelize;
  /** Tenant-scoped repository bound to this transaction context. */
  repo: (model: keyof Models) => ReturnType<typeof repo>;
  audit: (a: Omit<AuditInput, "tenantId" | "actorId" | "correlationId" | "ip">) => Promise<string>;
  emit: <T>(e: EmitInput<T>) => Promise<string>;
}

/**
 * Unit of work: one DB transaction that carries the business change, its audit entry and its outbox event.
 * If any of them fails, none of them commit.
 */
const isDeadlock = (e: any) => e?.original?.code === "ER_LOCK_DEADLOCK" || e?.parent?.code === "ER_LOCK_DEADLOCK" || e?.original?.errno === 1213;

/**
 * Unit of work: one DB transaction that carries the business change, its audit entry and its outbox event.
 * If any of them fails, none of them commit. A transaction picked as a deadlock victim is retried (a few times, with jitter):
 * MySQL has rolled it back completely, so re-running the whole function is safe for database work.
 */
export async function withUow<T>(sq: Sequelize, ctx: Ctx, fn: (u: Uow) => Promise<T>): Promise<T> {
  const models = initModels(sq);
  for (let attempt = 1; ; attempt++) {
    try {
      // READ COMMITTED: statements after a row lock (routing, unit reservation) must see rows committed while we waited,
      // which a REPEATABLE READ snapshot taken earlier in the transaction would hide.
      return await sq.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (tx) => {
        const u: Uow = {
          tx, models, sq,
          repo: (m) => repo(models[m], ctx),
          audit: (a) => recordAudit(sq, tx, { ...a, tenantId: ctx.tenantId, actorId: ctx.userId, correlationId: ctx.correlationId, ip: ctx.ip ?? null }),
          emit: (e) => emitEvent(sq, tx, ctx, e),
        };
        return fn(u);
      });
    } catch (e) {
      if (!isDeadlock(e) || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * attempt));
    }
  }
}

/** Enforce a numeric tenant quota (e.g. "users", "listings"). Missing quota row = unlimited. */
export async function assertQuota(u: Uow, ctx: Ctx, quotaKey: string, table: string): Promise<void> {
  const q = await u.repo("TenantQuota").findOne({ where: { quotaKey }, transaction: u.tx });
  if (!q) return;
  const limit = Number((q as any).get("limitValue"));
  const rows = (await u.sq.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE tenant_id = :t`, {
    replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT,
  })) as unknown as Array<{ n: number }>;
  if (Number(rows[0]?.n ?? 0) >= limit) throw new QuotaExceededError(quotaKey, limit);
}

/** Scheduler sweeps run as the system context; a human may trigger one only if they hold the permission (any scope). */
export function assertSweepAllowed(ctx: Pick<RequestContext, "userId" | "grants">, permission: string) {
  if (ctx.userId === "system") return;
  if (!ctx.grants.some((g) => g.permission === permission)) throw new ForbiddenSweepError(permission);
}

export class ForbiddenSweepError extends ForbiddenError {
  constructor(permission: string) {
    super(`Missing permission: ${permission}`);
  }
}
