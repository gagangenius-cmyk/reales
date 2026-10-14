import { templateCsv } from "@reales/domain";
import { templateQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: templateQuery }, async ({ query }) => new Response(`\uFEFF${templateCsv(query.kind)}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${query.kind}-template.csv"` } }));
