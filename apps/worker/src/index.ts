import "dotenv/config";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { getSequelize } from "@reales/database";
import { handleDomainEvent, processWebhookEvent } from "@reales/domain";
import { dispatchOutboxBatch } from "@reales/events";
import { logger, runWithCorrelation } from "@reales/observability";
import { BullMqPublisher, DOMAIN_EVENTS_QUEUE } from "./publisher";

process.env.SERVICE_NAME ??= "worker";

async function main() {
  const connection = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6380", { maxRetriesPerRequest: null });
  const queue = new Queue(DOMAIN_EVENTS_QUEUE, { connection });
  const publisher = new BullMqPublisher(queue);
  const sq = getSequelize();

  // Consumers subscribe here in later phases (workflow triggers, analytics, notifications).
  const worker = new Worker(
    DOMAIN_EVENTS_QUEUE,
    async (job) => runWithCorrelation({ correlationId: job.data.meta.correlationId, tenantId: job.data.meta.tenantId }, async () => {
      logger.info({ type: job.name, eventId: job.id }, "domain event received");
      // Provider callbacks are persisted by the web tier and processed here, off the request path.
      if (job.name === "webhook.received") await processWebhookEvent(sq, job.data.event.payload.webhookEventId);
      // Every domain event may start workflows or resume waiting ones (idempotent per event id).
      else await handleDomainEvent(sq, job.data.event);
    }),
    { connection, concurrency: 10 },
  );

  let stopping = false;
  const loop = (async () => {
    while (!stopping) {
      try {
        const { dispatched } = await dispatchOutboxBatch(sq, publisher, { limit: 100 });
        if (dispatched === 0) await new Promise((r) => setTimeout(r, 500));
      } catch (e) {
        logger.error({ err: e }, "outbox dispatch failed");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  const shutdown = async () => {
    stopping = true;
    await loop;
    await worker.close();
    await queue.close();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  logger.info("worker started");
}

main().catch((e) => { logger.error({ err: e }, "worker crashed"); process.exit(1); });
