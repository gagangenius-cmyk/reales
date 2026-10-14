import { createSavedSearch, listSavedSearches } from "@reales/domain";
import { savedSearchSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ searches: await listSavedSearches(sq, ctx) }));
export const POST = api({ body: savedSearchSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await createSavedSearch(sq, ctx, body) }));
