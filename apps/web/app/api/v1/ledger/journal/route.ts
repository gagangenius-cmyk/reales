import { NextResponse } from "next/server";
import { journal, journalCsv } from "@reales/domain";
import { ledgerQuery } from "@reales/validation";
import { api } from "@/lib/api";

/** The derived journal for a date range, as JSON or (format=csv) as a file for an accounting package. Tenant-wide finance access only. */
export const GET = api({ query: ledgerQuery }, async ({ ctx, sq, query }) => {
  if (query.format === "csv") {
    const f = await journalCsv(sq, ctx, query);
    return new NextResponse(f.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  return { entries: await journal(sq, ctx, query) };
});
