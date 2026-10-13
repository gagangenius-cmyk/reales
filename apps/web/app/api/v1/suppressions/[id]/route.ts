import { liftSuppression } from "@reales/domain";
import { liftSuppressionSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

/** Lifting a suppression needs a fresh second factor, a reason and is audited. */
export const DELETE = api<{ id: string }, typeof liftSuppressionSchema>({ body: liftSuppressionSchema }, async ({ ctx, sq, body, params }) => {
  await liftSuppression(sq, ctx, uuid.parse(params.id), body.reason);
  return { ok: true };
});
