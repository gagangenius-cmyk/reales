import { NextResponse } from "next/server";
import { deleteHrDocument, readHrDocument } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => {
  const d = await readHrDocument(sq, ctx, z.string().uuid().parse(params.id));
  return new NextResponse(new Uint8Array(d.bytes), { headers: { "content-type": d.mime, "content-disposition": `attachment; filename="${d.filename.replace(/[^\w. -]+/g, "_")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
export const DELETE = api<{ id: string }>({}, async ({ ctx, sq, params }) => deleteHrDocument(sq, ctx, z.string().uuid().parse(params.id)));
