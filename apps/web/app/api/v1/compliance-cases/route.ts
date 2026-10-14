import { listCases, openCase } from "@reales/domain";
import { caseListQuery, caseSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: caseListQuery }, async ({ ctx, sq, query }) => ({ cases: await listCases(sq, ctx, query) }));
export const POST = api({ body: caseSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await openCase(sq, ctx, body) }));
