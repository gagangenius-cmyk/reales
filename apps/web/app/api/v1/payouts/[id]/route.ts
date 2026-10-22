import { cancelPayout, decidePayout, markPayoutPaid } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const id = z.string().uuid();
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("decide"), outcome: z.enum(["approved", "rejected"]), reason: z.string().max(255).optional() }).strict(),
  z.object({ action: z.literal("pay"), reference: z.string().trim().min(1).max(120) }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
]);

export const POST = api<{ id: string }, typeof body>({ body }, async ({ ctx, sq, params, body: b }) => {
  const pid = id.parse(params.id);
  if (b.action === "decide") return decidePayout(sq, ctx, pid, { outcome: b.outcome, reason: b.reason });
  if (b.action === "pay") return markPayoutPaid(sq, ctx, pid, b.reference);
  return cancelPayout(sq, ctx, pid);
});
