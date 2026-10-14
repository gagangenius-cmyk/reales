import { listLegalHolds, placeLegalHold } from "@reales/domain";
import { legalHoldListQuery, legalHoldSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: legalHoldListQuery }, async ({ ctx, sq, query }) => ({ holds: await listLegalHolds(sq, ctx, query) }));
export const POST = api({ body: legalHoldSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await placeLegalHold(sq, ctx, body.contactId, body.reason) }));
