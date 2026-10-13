import { createHash, randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { mysqlDate } from "@reales/database";

export class IdempotencyError extends Error {
  constructor(public status: 409 | 422, message: string) {
    super(message);
    this.name = "IdempotencyError";
  }
}

const TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredResponse { status: number; body: unknown }

/**
 * Idempotency-Key handling (blueprint: request protection). The first request with a key runs and its
 * response is stored; a retry with the same key + same payload replays it; the same key with a different payload
 * is rejected. A concurrent duplicate while the first is running gets 409.
 */
export async function withIdempotency(
  sq: Sequelize,
  tenantId: string,
  scope: string,
  key: string,
  payload: unknown,
  run: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  if (key.length > 200) throw new IdempotencyError(422, "Idempotency-Key too long");
  const requestHash = createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
  const id = randomUUID();
  try {
    await sq.query(
      "INSERT INTO idempotency_keys (id, tenant_id, scope, `key`, request_hash, status, expires_at, created_at) VALUES (:id, :t, :scope, :key, :h, 'in_progress', :exp, NOW(3))",
      { replacements: { id, t: tenantId, scope, key, h: requestHash, exp: mysqlDate(new Date(Date.now() + TTL_MS)) } },
    );
  } catch (e: any) {
    if (e?.original?.code !== "ER_DUP_ENTRY" && e?.parent?.code !== "ER_DUP_ENTRY") throw e;
    const [row] = await sq.query<any>(
      "SELECT request_hash, status, response_status, response_body FROM idempotency_keys WHERE tenant_id=:t AND scope=:scope AND `key`=:key",
      { replacements: { t: tenantId, scope, key }, type: QueryTypes.SELECT },
    );
    if (!row) throw e;
    if (row.request_hash !== requestHash) throw new IdempotencyError(422, "Idempotency-Key was already used with a different request");
    if (row.status !== "completed") throw new IdempotencyError(409, "A request with this Idempotency-Key is still in progress");
    const body = typeof row.response_body === "string" ? JSON.parse(row.response_body) : row.response_body;
    return { status: row.response_status, body, replayed: true };
  }
  try {
    const res = await run();
    await sq.query(
      "UPDATE idempotency_keys SET status='completed', response_status=:s, response_body=:b WHERE id=:id AND tenant_id=:t",
      { replacements: { s: res.status, b: JSON.stringify(res.body ?? null), id, t: tenantId } },
    );
    return { ...res, replayed: false };
  } catch (err) {
    // A failed attempt must not poison the key: release it so the client can retry.
    await sq.query("DELETE FROM idempotency_keys WHERE id=:id AND tenant_id=:t AND status='in_progress'", { replacements: { id, t: tenantId } });
    throw err;
  }
}
