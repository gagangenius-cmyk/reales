import { NextResponse } from "next/server";
import { letterPdf } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => {
  const { bytes, filename } = await letterPdf(sq, ctx, z.string().uuid().parse(params.id));
  return new NextResponse(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "private, no-store" } });
});
