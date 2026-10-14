import { exportCsv } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const kind = z.enum(["contacts", "leads", "listings", "units"]);

export const GET = api<{ kind: string }>({}, async ({ ctx, sq, params }) => {
  const r = await exportCsv(sq, ctx, kind.parse(params.kind));
  return new Response(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${r.filename}"`, "x-content-type-options": "nosniff" } });
});
