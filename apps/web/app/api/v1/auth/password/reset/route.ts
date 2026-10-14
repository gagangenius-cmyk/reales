import { resetPassword } from "@reales/domain";
import { resetSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ auth: "none", body: resetSchema, limit: { limit: 10, windowSec: 60, key: "reset-ip" } }, async ({ sq, body }) => {
  await resetPassword(sq, body);
  return { ok: true };
});
