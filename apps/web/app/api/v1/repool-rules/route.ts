import { listRepoolRules, saveRepoolRule } from "@reales/domain";
import { repoolRuleSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ rules: await listRepoolRules(sq, ctx) }));
export const POST = api({ body: repoolRuleSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: body.id ? 200 : 201, data: await saveRepoolRule(sq, ctx, body) }));
