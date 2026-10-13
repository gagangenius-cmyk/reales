import { Queue } from "bullmq";
import type { DomainEvent, EventPublisher } from "@reales/events";

export const DOMAIN_EVENTS_QUEUE = "domain-events";

/**
 * Publishes outbox events to BullMQ. The event id is used as the job id, so a re-dispatch after a crash
 * between publish and mark-dispatched is deduplicated by Redis (at-least-once becomes effectively-once here).
 * Every job carries the immutable tenancy metadata (tenantId, actorId, correlationId).
 */
export class BullMqPublisher implements EventPublisher {
  constructor(private readonly queue: Queue) {}

  async publish(event: DomainEvent): Promise<void> {
    await this.queue.add(
      event.type,
      { event, meta: { tenantId: event.tenantId, projectId: event.projectId ?? null, actorId: event.actorId ?? null, correlationId: event.correlationId } },
      { jobId: event.id, attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 7 * 24 * 3600 } },
    );
  }
}
