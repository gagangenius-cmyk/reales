import { afterAll, describe, expect, it } from "vitest";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { dispatchOutboxBatch, emitEvent } from "@reales/events";
import { BullMqPublisher } from "../apps/worker/src/publisher";
import { closeTestDb, makeTenant, testDb } from "./helpers";

afterAll(closeTestDb);

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6380";

async function redisAvailable() {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  r.on("error", () => {});
  try { await r.connect(); await r.ping(); return true; } catch { return false; } finally { r.disconnect(); }
}

describe("worker: outbox -> BullMQ", async () => {
  const up = await redisAvailable();
  it.skipIf(!up)("delivers outbox events to the queue exactly once with tenancy metadata", async () => {
    const t = await makeTenant();
    const name = `test-events-${Date.now()}`;
    const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue(name, { connection });
    const got: any[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const w = new Worker(name, async (job) => {
      got.push(job);
      if (got.some((j) => j.data.event.tenantId === t.tenantId && job.name === "lead.created")) resolveDone();
    }, { connection: connection.duplicate() });

    await testDb().transaction((tx) => emitEvent(testDb(), tx, t.admin, { type: "lead.created", aggregateType: "lead", aggregateId: "l1", payload: { budget: 3_000_000 } }));
    const pub = new BullMqPublisher(queue);
    for (let i = 0; i < 100; i++) if ((await dispatchOutboxBatch(testDb(), pub, { limit: 200 })).dispatched === 0) break; // drain like the real loop
    await dispatchOutboxBatch(testDb(), pub, { limit: 200 }); // second pass: nothing pending, must not duplicate
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for job")), 10_000))]);

    const mine = got.filter((j) => j.data.event.tenantId === t.tenantId && j.name === "lead.created");
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe("lead.created");
    expect(mine[0].data.meta).toEqual({ tenantId: t.tenantId, projectId: null, actorId: t.adminId, correlationId: t.admin.correlationId });
    await w.close();
    await queue.obliterate({ force: true });
    await queue.close();
    connection.disconnect();
  });
});
