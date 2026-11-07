import { NextRequest, NextResponse } from "next/server";
import { handleCalendarPush } from "@reales/domain";
import { getSequelize } from "@reales/database";
import { logger } from "@reales/observability";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Google Calendar webhook (push notification). It does not use the session: the call is authenticated by the channel id and the secret token we chose when registering the channel. The body is empty; the channel id and the secret token we chose when registering the channel are in headers.
 * An unknown channel or wrong token is answered exactly like a good one (200) so the endpoint reveals nothing.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-real-ip") ?? "anon";
  const rl = await rateLimit(`google-push:${ip}`, 300, 60);
  if (!rl.allowed) return new NextResponse(null, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  try {
    await handleCalendarPush(getSequelize(), req.headers.get("x-goog-channel-id"), req.headers.get("x-goog-channel-token"));
  } catch (e) {
    logger.error({ err: e }, "google calendar push handling failed");
  }
  return new NextResponse(null, { status: 200 });
}
