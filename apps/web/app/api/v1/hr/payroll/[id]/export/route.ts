import { NextResponse } from "next/server";
import { requireStepUp } from "@reales/auth";
import { payrollBankCsv } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

/** Bank upload file. Contains account numbers: second factor required, and every export is audited. */
export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => {
  requireStepUp(ctx);
  const f = await payrollBankCsv(sq, ctx, z.string().uuid().parse(params.id));
  return new NextResponse(f.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
