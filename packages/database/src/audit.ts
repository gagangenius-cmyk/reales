import { createHash, randomUUID } from "node:crypto";
import { QueryTypes, Sequelize, Transaction } from "sequelize";
import { mysqlDate } from "./connection";

export interface AuditInput {
  tenantId: string;
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  correlationId: string;
  ip?: string | null;
}

/** Deterministic JSON (sorted keys). MySQL JSON columns re-order object keys, so hashing raw JSON.stringify would break on read-back. */
export function canonicalJson(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function chainHash(prev: string | null, seq: number, a: AuditInput, createdAt: string): string {
  return createHash("sha256")
    .update(
      canonicalJson([prev, seq, a.tenantId, a.actorId ?? null, a.action, a.entityType ?? null, a.entityId ?? null,
        a.before ?? null, a.after ?? null, a.reason ?? null, a.correlationId, createdAt]),
    )
    .digest("hex");
}

/**
 * Append a tamper-evident audit record inside the caller's transaction so the business change and its
 * audit entry commit (or roll back) together. Per-tenant serialisation via the tenant row lock keeps
 * the hash chain gap-free. The table is append-only at the database level (triggers).
 */
export async function recordAudit(sequelize: Sequelize, tx: Transaction, a: AuditInput): Promise<string> {
  await sequelize.query("SELECT id FROM tenants WHERE id = :t FOR UPDATE", { replacements: { t: a.tenantId }, transaction: tx, type: QueryTypes.SELECT });
  const last = await sequelize.query<{ seq: string; hash: string }>(
    "SELECT seq, hash FROM audit_events WHERE tenant_id = :t ORDER BY seq DESC LIMIT 1",
    { replacements: { t: a.tenantId }, transaction: tx, type: QueryTypes.SELECT },
  );
  const seq = last[0] ? Number(last[0].seq) + 1 : 1;
  const prev = last[0]?.hash ?? null;
  const createdAt = new Date();
  const iso = createdAt.toISOString();
  const hash = chainHash(prev, seq, a, iso);
  const id = randomUUID();
  await sequelize.query(
    `INSERT INTO audit_events (id, tenant_id, seq, actor_id, action, entity_type, entity_id, \`before\`, \`after\`, reason, correlation_id, ip, prev_hash, hash, created_at)
     VALUES (:id, :tenantId, :seq, :actorId, :action, :entityType, :entityId, :before, :after, :reason, :correlationId, :ip, :prev, :hash, :createdAt)`,
    {
      transaction: tx,
      replacements: {
        id, tenantId: a.tenantId, seq, actorId: a.actorId ?? null, action: a.action, entityType: a.entityType ?? null,
        entityId: a.entityId ?? null, before: a.before === undefined ? null : JSON.stringify(a.before),
        after: a.after === undefined ? null : JSON.stringify(a.after), reason: a.reason ?? null,
        correlationId: a.correlationId, ip: a.ip ?? null, prev, hash, createdAt: mysqlDate(createdAt),
      },
    },
  );
  return id;
}

/** Recompute the chain; returns the first broken seq or null when intact. */
export async function verifyAuditChain(sequelize: Sequelize, tenantId: string): Promise<number | null> {
  const rows = await sequelize.query<any>("SELECT * FROM audit_events WHERE tenant_id = :t ORDER BY seq ASC", {
    replacements: { t: tenantId }, type: QueryTypes.SELECT,
  });
  let prev: string | null = null;
  for (const r of rows) {
    const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v ?? null);
    const input: AuditInput = {
      tenantId: r.tenant_id, actorId: r.actor_id, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
      before: parse(r.before), after: parse(r.after), reason: r.reason, correlationId: r.correlation_id,
    };
    const expected = chainHash(prev, Number(r.seq), input, new Date(r.created_at).toISOString());
    if (r.prev_hash !== prev || r.hash !== expected) return Number(r.seq);
    prev = r.hash;
  }
  return null;
}
