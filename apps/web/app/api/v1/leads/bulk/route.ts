import { bulkLeadAction } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();
const body = z.object({
  ids: z.array(uuid).min(1).max(100),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("assign"), userId: uuid.nullable() }).strict(),
    z.object({ type: z.literal("stage"), stageKey: z.string().min(1).max(40), reason: z.string().max(255).optional() }).strict(),
    z.object({ type: z.literal("hot"), value: z.boolean() }).strict(),
    z.object({ type: z.literal("tag"), tag: z.string().trim().min(1).max(40) }).strict(),
  ]),
}).strict();

export const POST = api<Record<string, string>, typeof body>({ body, idempotent: true }, async ({ ctx, sq, body: b }) => bulkLeadAction(sq, ctx, b.ids, b.action));
