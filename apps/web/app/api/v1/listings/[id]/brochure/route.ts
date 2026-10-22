import { NextResponse } from "next/server";
import { listingBrochure } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => {
  const bytes = await listingBrochure(sq, ctx, z.string().uuid().parse(params.id));
  return new NextResponse(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="listing-brochure.pdf"', "cache-control": "private, no-store" } });
});
