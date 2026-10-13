import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize, Transaction } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";

/** Formal event envelope (blueprint: domain event foundation). Event types look like `lead.created.v1`. */
export type DomainEvent<T = unknown> = {
  id: string;
  type: string;
  version: number;
  tenantId: string;
  projectId?: string | null;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  actorId?: string | null;
  correlationId: string;
  causationId?: string | null;
  payload: T;
};

export interface EmitInput<T> {
  type: string; // e.g. "user.created"
  version?: number;
  aggregateType: string;
  aggregateId: string;
  projectId?: string | null;
  causationId?: string | null;
  payload: T;
}

/**
 * Write the event to the outbox in the SAME transaction as the business change, so the change
 * and its event commit atomically. A dispatcher publishes it afterwards (no "db ok, queue failed" loss).
 */
export async function emitEvent<T>(
  sequelize: Sequelize,
  tx: Transaction,
  ctx: Pick<RequestContext, "tenantId" | "userId" | "correlationId">,
  e: EmitInput<T>,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await sequelize.query(
    `INSERT INTO outbox_events (id, tenant_id, type, version, project_id, aggregate_type, aggregate_id, actor_id, correlation_id, causation_id, payload, occurred_at, status, attempts, next_attempt_at)
     VALUES (:id, :tenantId, :type, :version, :projectId, :aggregateType, :aggregateId, :actorId, :correlationId, :causationId, :payload, :now, 'pending', 0, :now)`,
    {
      transaction: tx,
      replacements: {
        id, tenantId: ctx.tenantId, type: e.type, version: e.version ?? 1, projectId: e.projectId ?? null,
        aggregateType: e.aggregateType, aggregateId: e.aggregateId, actorId: ctx.userId === "system" ? null : ctx.userId,
        correlationId: ctx.correlationId, causationId: e.causationId ?? null, payload: JSON.stringify(e.payload ?? {}), now: mysqlDate(now),
      },
    },
  );
  return id;
}

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

const MAX_ATTEMPTS = 10;

export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 30, 1000 * 2 ** attempts);
}

/**
 * One dispatcher pass. Rows are claimed with FOR UPDATE SKIP LOCKED so several dispatcher pods can run
 * concurrently. Delivery is at-least-once; consumers must be idempotent (dedupe on event id).
 */
export async function dispatchOutboxBatch(
  sequelize: Sequelize,
  publisher: EventPublisher,
  opts: { limit?: number; now?: Date } = {},
): Promise<{ dispatched: number; failed: number }> {
  const limit = opts.limit ?? 50;
  const now = opts.now ?? new Date();
  let dispatched = 0;
  let failed = 0;
  await sequelize.transaction(async (tx) => {
    const rows = await sequelize.query<any>(
      `SELECT * FROM outbox_events WHERE status = 'pending' AND next_attempt_at <= :now ORDER BY occurred_at ASC, id ASC LIMIT ${Number(limit)} FOR UPDATE SKIP LOCKED`,
      { replacements: { now: mysqlDate(now) }, transaction: tx, type: QueryTypes.SELECT },
    );
    for (const r of rows) {
      const event: DomainEvent = {
        id: r.id, type: r.type, version: r.version, tenantId: r.tenant_id, projectId: r.project_id,
        aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, occurredAt: new Date(r.occurred_at).toISOString(),
        actorId: r.actor_id, correlationId: r.correlation_id, causationId: r.causation_id,
        payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
      };
      try {
        await publisher.publish(event);
        await sequelize.query("UPDATE outbox_events SET status='dispatched', dispatched_at=:now WHERE id=:id", { replacements: { now: mysqlDate(new Date()), id: r.id }, transaction: tx });
        dispatched++;
      } catch (err) {
        const attempts = r.attempts + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        await sequelize.query(
          "UPDATE outbox_events SET attempts=:attempts, status=:status, next_attempt_at=:next, last_error=:err WHERE id=:id",
          {
            replacements: {
              attempts, status: dead ? "failed" : "pending", next: mysqlDate(new Date(now.getTime() + backoffMs(attempts))),
              err: String((err as Error)?.message ?? err).slice(0, 2000), id: r.id,
            },
            transaction: tx,
          },
        );
        failed++;
      }
    }
  });
  return { dispatched, failed };
}

/** Consumer-side dedupe helper: keeps the set of processed event ids for at-least-once delivery. */
export class InMemoryDedupe {
  private seen = new Set<string>();
  once(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}
