import { listCalls, logCall } from "@reales/domain";
import { callListQuery, callSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: callListQuery }, async ({ ctx, sq, query }) => ({ calls: await listCalls(sq, ctx, query) }));
export const POST = api({ body: callSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await logCall(sq, ctx, body) }));
