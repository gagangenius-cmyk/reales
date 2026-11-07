import { createApiKey, listApiKeys } from "@reales/domain";
import { apiKeySchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => listApiKeys(sq, ctx));
/** Returns the key once. Needs a recent second-factor step-up. */
export const POST = api({ body: apiKeySchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await createApiKey(sq, ctx, body) }));
