import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getSequelize } from "@reales/database";
import { ConflictError, receiveIngestedLeads, verifyIngestHandshake, WebhookSignatureError } from "@reales/domain";
import { logger } from "@reales/observability";
import { clientIp } from "./api";
import { rateLimit } from "./rate-limit";

const MAX_BODY = 512 * 1024;

/**
 * Inbound lead webhook (Meta connector, portals, web forms, anything that can POST JSON). No session and no Origin check: the sender proves
 * itself by an HMAC-SHA256 signature of the RAW body (header x-signature, or x-hub-signature-256 for Meta) made with the source's secret.
 * A wrong public id and a wrong signature give the same 401, so the endpoint does not reveal which sources exist.
 */
export const leadIngestHandlers = {
  async POST(req: NextRequest, route: { params: Promise<{ publicId: string }> }) {
    const correlationId = `corr_${randomUUID()}`;
    const { publicId } = await route.params;
    try {
      const rl = await rateLimit(`leadingest:${publicId}:${clientIp(req) ?? "anon"}`, 300, 60);
      if (!rl.allowed) return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "60" } });
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return NextResponse.json({ error: { code: "payload_too_large" } }, { status: 413 });
      const rawBody = await req.text();
      if (rawBody.length > MAX_BODY) return NextResponse.json({ error: { code: "payload_too_large" } }, { status: 413 });
      const headers: Record<string, string | null> = {};
      req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const r = await receiveIngestedLeads(getSequelize(), { publicId, rawBody, headers });
      return NextResponse.json({ status: "ok", ...r }, { status: 200, headers: { "x-correlation-id": correlationId } });
    } catch (e) {
      if (e instanceof WebhookSignatureError) return NextResponse.json({ error: { code: "invalid_signature" } }, { status: 401 });
      if (e instanceof ConflictError) return NextResponse.json({ error: { code: "bad_request", message: e.message } }, { status: 400 });
      logger.error({ err: e, publicId, correlationId }, "lead ingestion failed");
      return NextResponse.json({ error: { code: "internal_error", correlationId } }, { status: 500 });
    }
  },
  /** Meta webhook handshake: echo hub.challenge when hub.verify_token matches the source secret. */
  async GET(req: NextRequest, route: { params: Promise<{ publicId: string }> }) {
    const { publicId } = await route.params;
    const q = req.nextUrl.searchParams;
    const ok = q.get("hub.mode") === "subscribe" && (await verifyIngestHandshake(getSequelize(), publicId, q.get("hub.verify_token")));
    return ok ? new NextResponse(q.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } }) : NextResponse.json({ error: { code: "forbidden" } }, { status: 403 });
  },
};
