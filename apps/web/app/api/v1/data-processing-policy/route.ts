import { getDataProcessingPolicy, setDataProcessingPolicy } from "@reales/domain";
import { policySchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ policy: await getDataProcessingPolicy(sq, ctx) }));
export const PUT = api({ body: policySchema }, async ({ ctx, sq, body }) => setDataProcessingPolicy(sq, ctx, body));
