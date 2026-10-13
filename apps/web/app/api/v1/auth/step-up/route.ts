import { performStepUp } from "@reales/auth";
import { mfaCodeSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: mfaCodeSchema, limit: { limit: 10, windowSec: 60, key: "step-up" } }, async ({ ctx, body, sq }) => {
  await performStepUp(sq, ctx, body.code);
  return { ok: true };
});
