// Public photo: unguessable listing token + photo id. Only works while the listing is published; served immutable-cached because the bytes never change for a given id.
import { NextRequest, NextResponse } from "next/server";
import { getSequelize } from "@reales/database";
import { NotFoundError, readPublicMedia } from "@reales/domain";
import { z } from "@reales/validation";
import { clientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

export async function GET(req: NextRequest, route: { params: Promise<{ token: string; mediaId: string }> }) {
  const { token, mediaId } = await route.params;
  if (!z.string().uuid().safeParse(mediaId).success) return new NextResponse(null, { status: 404 });
  const rl = await rateLimit(`media:${clientIp(req) ?? "anon"}`, 600, 60);
  if (!rl.allowed) return new NextResponse(null, { status: 429, headers: { "retry-after": "60" } });
  try {
    const m = await readPublicMedia(getSequelize(), token, mediaId);
    return new NextResponse(new Uint8Array(m.bytes), { headers: { "content-type": m.mime, "cache-control": "public, max-age=86400, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" } });
  } catch (e) {
    if (e instanceof NotFoundError) return new NextResponse(null, { status: 404 });
    throw e;
  }
}
