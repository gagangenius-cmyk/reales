import { beginSso } from "@reales/domain";
import { ssoBeginSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ auth: "none", body: ssoBeginSchema, limit: { limit: 20, windowSec: 60, key: "sso-begin-ip" } }, async ({ req, sq, body }) => {
  const origin = process.env.APP_URL ?? req.nextUrl.origin;
  return beginSso(sq, { tenantSlug: body.tenant, email: body.email, redirectUri: `${origin}/api/v1/auth/sso/callback` });
});
