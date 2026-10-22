import { NextRequest, NextResponse } from "next/server";
import { getSequelize } from "@reales/database";
import { resolveSite } from "@reales/domain";

export async function GET(req: NextRequest, route: { params: Promise<{ slug: string }> }) {
  const { slug } = await route.params;
  const site = await resolveSite(getSequelize(), slug);
  if (!site) return new NextResponse("User-agent: *\nDisallow: /\n", { status: 404, headers: { "content-type": "text/plain" } });
  const origin = (process.env.PUBLIC_BASE_URL ?? process.env.APP_URL ?? req.nextUrl.origin).replace(/\/$/, "");
  return new NextResponse(`User-agent: *\nAllow: /p/${slug}\nDisallow: /api/\nSitemap: ${origin}/p/${slug}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } });
}
