import { hostname } from "node:os";
import { QueryTypes, Sequelize } from "sequelize";
import { mysqlDate } from "@reales/database";

const INSTANCE = `${hostname()}-${process.pid}`;
const STARTED = new Date();
const last = new Map<string, number>();
const EVERY_MS = 30_000;

/** Called by the scheduler and worker on every loop. Never throws: a failed heartbeat must not stop real work. */
export async function recordHeartbeat(sq: Sequelize, service: "scheduler" | "worker", details: Record<string, unknown> = {}): Promise<void> {
  if (Date.now() - (last.get(service) ?? 0) < EVERY_MS) return; // loops spin faster than a heartbeat needs
  last.set(service, Date.now());
  try {
    await sq.query(
      "INSERT INTO service_heartbeats (service, instance, beat_at, started_at, details) VALUES (:s, :i, :now, :st, :d) ON DUPLICATE KEY UPDATE beat_at = VALUES(beat_at), details = VALUES(details)",
      { replacements: { s: service, i: INSTANCE, now: mysqlDate(new Date()), st: mysqlDate(STARTED), d: JSON.stringify(details) } },
    );
  } catch { /* table missing before the migration, or a brief database outage */ }
}

export interface ServiceStatus { service: string; instances: number; lastBeatSeconds: number | null; healthy: boolean }

/** Is each required service alive? A service counts as healthy when any instance beat within `maxAgeSec`. */
export async function backgroundStatus(sq: Sequelize, required: string[] = ["scheduler", "worker"], maxAgeSec = 300): Promise<ServiceStatus[]> {
  const rows = await sq.query<{ service: string; n: number; age: number | null }>(
    "SELECT service, COUNT(*) AS n, TIMESTAMPDIFF(SECOND, MAX(beat_at), UTC_TIMESTAMP(3)) AS age FROM service_heartbeats GROUP BY service",
    { type: QueryTypes.SELECT },
  );
  return required.map((s) => {
    const r = rows.find((x) => x.service === s);
    const age = r?.age == null ? null : Number(r.age);
    return { service: s, instances: Number(r?.n ?? 0), lastBeatSeconds: age, healthy: age !== null && age <= maxAgeSec };
  });
}
