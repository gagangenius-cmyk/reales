import { requestPasswordReset } from "@reales/domain";
import { forgotSchema } from "@reales/validation";
import { api, clientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

// Identical response whatever happens, so the endpoint cannot be used to discover accounts.
export const POST = api({ auth: "none", body: forgotSchema, limit: { limit: 10, windowSec: 60, key: "forgot-ip" } }, async ({ req, sq, body }) => {
  const acct = await rateLimit(`forgot-acct:${body.tenant}:${body.email.toLowerCase()}`, 3, 3600);
  if (acct.allowed) await requestPasswordReset(sq, { tenantSlug: body.tenant, email: body.email, baseUrl: process.env.APP_URL ?? req.nextUrl.origin });
  void clientIp;
  return { ok: true };
});
