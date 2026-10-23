// Calendar subscription feed: Google Calendar, Outlook and Apple Calendar poll this secret URL. No session; the token IS the credential (rotate it on the Calendar page).
import { NextRequest, NextResponse } from "next/server";
import { getSequelize } from "@reales/database";
import { calendarFeedByToken } from "@reales/domain";
import { clientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

export async function GET(req: NextRequest, route: { params: Promise<{ token: string }> }) {
  const token = (await route.params).token.replace(/\.ics$/i, "");
  const rl = await rateLimit(`calfeed:${token.slice(0, 12)}:${clientIp(req) ?? "anon"}`, 60, 60);
  if (!rl.allowed) return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "60" } });
  const ics = await calendarFeedByToken(getSequelize(), token);
  if (!ics) return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  return new NextResponse(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "content-disposition": 'inline; filename="reales-crm.ics"' } });
}
