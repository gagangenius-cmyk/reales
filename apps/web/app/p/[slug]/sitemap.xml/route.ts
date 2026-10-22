import { NextRequest, NextResponse } from "next/server";
import { getSequelize } from "@reales/database";
import { resolveSite, siteSitemap } from "@reales/domain";

export async function GET(req: NextRequest, route: { params: Promise<{ slug: string }> }) {
  const { slug } = await route.params;
  const sq = getSequelize();
  const site = await resolveSite(sq, slug);
  if (!site) return new NextResponse(null, { status: 404 });
  const origin = (process.env.PUBLIC_BASE_URL ?? process.env.APP_URL ?? req.nextUrl.origin).replace(/\/$/, "");
  const rows = await siteSitemap(sq, site);
  const url = (p: string, d?: Date) => `<url><loc>${origin}${p}</loc>${d ? `<lastmod>${new Date(d).toISOString().slice(0, 10)}</lastmod>` : ""}</url>`;
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${url(`/p/${slug}`)}${rows.map((r) => url(`/p/${slug}/${r.reference}`, r.updated_at)).join("")}</urlset>`;
  return new NextResponse(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
