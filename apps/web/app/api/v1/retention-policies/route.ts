import { listRetentionPolicies, setRetentionPolicy } from "@reales/domain";
import { retentionPolicySchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ policies: await listRetentionPolicies(sq, ctx) }));
export const PUT = api({ body: retentionPolicySchema }, async ({ ctx, sq, body }) => setRetentionPolicy(sq, ctx, body));
