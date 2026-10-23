import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getSequelize } from "@reales/database";
import { getMessagingProvider, ingestWebhook, processWebhookEvent, WebhookKind, WebhookSignatureError } from "@reales/domain";
import { logger } from "@reales/observability";
import { clientIp } from "./api";
import { rateLimit } from "./rate-limit";

const MAX_BODY = 1024 * 1024;

/**
 * Provider callback endpoint. No session and no Origin check (providers are servers): authenticity comes from the provider signature,
 * verified over the RAW body before anything is stored. The handler acknowledges quickly; processing runs in the worker
 * (or inline when WEBHOOK_PROCESS_INLINE=1, a development convenience).
 */
export function webhookHandler(kind: WebhookKind) {
  return async (req: NextRequest, route: { params: Promise<{ provider: string }> }) => {
    const correlationId = `corr_${randomUUID()}`;
    const { provider } = await route.params;
    try {
      const rl = await rateLimit(`webhook:${kind}:${provider}:${clientIp(req) ?? "anon"}`, 600, 60);
      if (!rl.allowed) return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "60" } });
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return NextResponse.json({ error: { code: "payload_too_large" } }, { status: 413 });
      const rawBody = await req.text();
      if (rawBody.length > MAX_BODY) return NextResponse.json({ error: { code: "payload_too_large" } }, { status: 413 });
      const headers: Record<string, string | null> = {};
      req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const sq = getSequelize();
      // A provider that batches events (WhatsApp Cloud) is verified once over the whole delivery, then each event is stored on its own.
      const mp = kind === "messaging" ? getMessagingProvider(provider) : null;
      if (mp?.splitWebhook) {
        if (!mp.verifyWebhook(rawBody, headers)) throw new WebhookSignatureError();
        const parts = mp.splitWebhook(rawBody);
        let queued = 0;
        for (const part of parts) {
          const r = await ingestWebhook(sq, { kind, provider, rawBody: part, headers, verified: true });
          if (r.status === "queued" && r.id) { queued++; if (process.env.WEBHOOK_PROCESS_INLINE === "1") await processWebhookEvent(sq, r.id); }
        }
        return NextResponse.json({ status: parts.length === 0 ? "ignored" : "queued", events: parts.length, queued }, { status: 200, headers: { "x-correlation-id": correlationId } });
      }
      const r = await ingestWebhook(sq, { kind, provider, rawBody, headers });
      if (r.status === "queued" && r.id && process.env.WEBHOOK_PROCESS_INLINE === "1") await processWebhookEvent(sq, r.id);
      return NextResponse.json({ status: r.status }, { status: 200, headers: { "x-correlation-id": correlationId } });
    } catch (e) {
      if (e instanceof WebhookSignatureError) {
        logger.warn({ provider, kind, correlationId }, "webhook rejected: invalid signature");
        return NextResponse.json({ error: { code: "invalid_signature" } }, { status: 401 });
      }
      logger.error({ err: e, provider, kind, correlationId }, "webhook ingestion failed");
      // 500 makes the provider retry; the raw event dedupe makes retries safe.
      return NextResponse.json({ error: { code: "internal_error", correlationId } }, { status: 500 });
    }
  };
}
