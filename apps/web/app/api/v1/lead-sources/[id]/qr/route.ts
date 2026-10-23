import QRCode from "qrcode";
import { NextResponse } from "next/server";
import { listIngestSources } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

/** SVG QR code that opens the hosted lead form of a website-type source (for signage, brochures and social posts). */
export const GET = api<{ id: string }>({}, async ({ ctx, sq, params, req }) => {
  const id = z.string().uuid().parse(params.id);
  const src = (await listIngestSources(sq, ctx)).sources.find((s: any) => s.id === id) as any;
  if (!src || src.kind !== "website") return NextResponse.json({ error: { code: "not_found", message: "Only website sources have a public form" } }, { status: 404 });
  const svg = await QRCode.toString(`${req.nextUrl.origin}/f/${src.publicId}`, { type: "svg", margin: 2, width: 512, errorCorrectionLevel: "M" });
  return new NextResponse(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "private, max-age=3600", "content-disposition": `inline; filename="lead-form-${src.publicId}.svg"` } });
});
