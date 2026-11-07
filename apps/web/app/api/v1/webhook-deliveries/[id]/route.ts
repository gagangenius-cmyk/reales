import { retryWebhookDelivery } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

/** POST = retry this delivery. */
export const POST = api<{ id: string }>({}, async ({ ctx, sq, params }) => {
  await retryWebhookDelivery(sq, ctx, z.string().uuid().parse(params.id));
  return { ok: true };
});
