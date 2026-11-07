import { createClaimBatch, listClaimBatches } from "@reales/domain";
import { claimCreateSchema, claimListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: claimListQuery }, async ({ ctx, sq, query }) => ({ batches: await listClaimBatches(sq, ctx, { status: query.status }) }));
export const POST = api({ body: claimCreateSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createClaimBatch(sq, ctx, body) }));
