import { NextRequest, NextResponse } from "next/server";
import { getSequelize } from "@reales/database";
import { getSiteListing, publicBrochure, resolveSite } from "@reales/domain";
import { clientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

export async function GET(req: NextRequest, route: { params: Promise<{ slug: string; reference: string }> }) {
  const { slug, reference } = await route.params;
  const rl = await rateLimit(`brochure:${clientIp(req) ?? "anon"}`, 30, 60);
  if (!rl.allowed) return new NextResponse(null, { status: 429, headers: { "retry-after": "60" } });
  const sq = getSequelize();
  const site = await resolveSite(sq, slug);
  const l = site ? await getSiteListing(sq, site, reference, false) : null;
  if (!site || !l) return new NextResponse(null, { status: 404 });
  const bytes = await publicBrochure(sq, l.token, { accent: site.settings.primaryColor, phone: site.settings.phone, email: site.settings.email });
  if (!bytes) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${l.reference}.pdf"`, "cache-control": "public, max-age=600" } });
}
