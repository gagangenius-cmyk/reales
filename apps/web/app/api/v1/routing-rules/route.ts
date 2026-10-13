import { createRoutingRule, listRoutingRules } from "@reales/domain";
import { routingRuleSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ rules: await listRoutingRules(sq, ctx) }));
export const POST = api({ body: routingRuleSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createRoutingRule(sq, ctx, body) }));
