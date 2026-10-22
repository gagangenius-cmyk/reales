// Portal feed: portals such as Bayut poll this unguessable URL. No session; the token IS the credential (rotate it from Distribution).
import { NextRequest, NextResponse } from "next/server";
import { getSequelize } from "@reales/database";
import { buildFeedByToken } from "@reales/domain";
import { clientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

export async function GET(req: NextRequest, route: { params: Promise<{ token: string }> }) {
  const { token } = await route.params;
  const rl = await rateLimit(`feed:${token.slice(0, 12)}:${clientIp(req) ?? "anon"}`, 120, 60);
  if (!rl.allowed) return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "60" } });
  const feed = await buildFeedByToken(getSequelize(), token);
  if (!feed) return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  return new NextResponse(feed.body, { headers: { "content-type": feed.contentType, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
}
