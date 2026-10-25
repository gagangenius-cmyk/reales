// Twilio callbacks (webhook): call status ("status") and the TwiML that bridges an agent to a lead ("connect"). Authenticity is Twilio's signature, checked before anything is written.
import { NextRequest, NextResponse } from "next/server";
import { getSequelize } from "@reales/database";
import { callbackUrl, handleTwilioStatus, NotFoundError, twilioConnectXml } from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { clientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

const UUID = /^[0-9a-f-]{36}$/i;

export async function POST(req: NextRequest, route: { params: Promise<{ tenantId: string; leg: string }> }) {
  const { tenantId, leg } = await route.params;
  if (!UUID.test(tenantId) || (leg !== "status" && leg !== "connect")) return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  const rl = await rateLimit(`voice:${tenantId}:${clientIp(req) ?? "anon"}`, 300, 60);
  if (!rl.allowed) return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "60" } });
  const raw = await req.text();
  if (raw.length > 64 * 1024) return NextResponse.json({ error: { code: "payload_too_large" } }, { status: 413 });
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const signature = req.headers.get("x-twilio-signature");
  const url = callbackUrl(tenantId, leg, req.nextUrl.search);
  try {
    const sq = getSequelize();
    if (leg === "connect") return new NextResponse(await twilioConnectXml(sq, tenantId, params, req.nextUrl.searchParams, signature, url), { headers: { "content-type": "text/xml; charset=utf-8" } });
    return NextResponse.json(await handleTwilioStatus(sq, tenantId, params, signature, url));
  } catch (e) {
    if (e instanceof ForbiddenError) return NextResponse.json({ error: { code: "forbidden" } }, { status: 403 });
    if (e instanceof NotFoundError) return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
    throw e;
  }
}
