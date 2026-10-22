import { NextResponse } from "next/server";
import { clientListingsPdf } from "@reales/domain";
import { shortlistPdfSchema } from "@reales/validation";
import { api } from "@/lib/api";

/** Client-ready PDF of the listings an agent selected. Every listing goes through the normal visibility rules; nothing is stored. */
export const POST = api({ body: shortlistPdfSchema, limit: { limit: 20, windowSec: 60, key: "shortlist-pdf" } }, async ({ ctx, sq, body }) => {
  const bytes = await clientListingsPdf(sq, ctx, body);
  const name = (body.clientName ?? "shortlist").replace(/[^\w-]+/g, "_").slice(0, 40) || "shortlist";
  return new NextResponse(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}-properties.pdf"`, "cache-control": "private, no-store" } });
});
