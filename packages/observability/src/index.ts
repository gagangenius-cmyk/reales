import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import pino from "pino";

export interface CorrelationStore {
  correlationId: string;
  tenantId?: string;
  actorId?: string;
}

const als = new AsyncLocalStorage<CorrelationStore>();

export function newCorrelationId(): string {
  return `corr_${randomUUID()}`;
}

export function runWithCorrelation<T>(store: CorrelationStore, fn: () => T): T {
  return als.run(store, fn);
}

export function currentCorrelation(): CorrelationStore | undefined {
  return als.getStore();
}

// Never log secrets, tokens, passwords or identity documents (blueprint: security architecture).
const REDACT = [
  "password", "*.password", "token", "*.token", "accessToken", "refreshToken", "secret", "*.secret",
  "authorization", "headers.authorization", "headers.cookie", "otp", "code", "emiratesId", "passportNumber",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: REDACT, censor: "[redacted]" },
  base: { service: process.env.SERVICE_NAME ?? "reales" },
  mixin() {
    const s = als.getStore();
    return s ? { correlationId: s.correlationId, tenantId: s.tenantId, actorId: s.actorId } : {};
  },
});

export { trace, metrics, SpanStatusCode } from "@opentelemetry/api";
import { trace, SpanStatusCode } from "@opentelemetry/api";

/** Wrap work in an OpenTelemetry span. No-ops until an SDK is registered by the host app. */
export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const tracer = trace.getTracer("reales");
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}
