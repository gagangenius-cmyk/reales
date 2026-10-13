import { sendUserMessage } from "@reales/domain";
import { sendMessageSchema } from "@reales/validation";
import { api } from "@/lib/api";

/** Always passes through the consent/suppression gate; a blocked send returns 422 with the reasons rather than silently dropping. */
export const POST = api({ body: sendMessageSchema, idempotent: true }, async ({ ctx, sq, body, req }) => {
  const r = await sendUserMessage(sq, ctx, { ...body, idempotencyKey: req.headers.get("idempotency-key") ?? undefined } as any);
  return { status: r.status === "blocked" ? 422 : r.status === "sent" ? 201 : 202, data: r };
});
