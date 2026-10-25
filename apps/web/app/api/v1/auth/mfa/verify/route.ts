import { completeMfa } from "@reales/auth";
import { mfaCodeSchema } from "@reales/validation";
import { api, clientIp, sessionToken } from "@/lib/api";

export const POST = api({ auth: "pending-mfa", body: mfaCodeSchema, limit: { limit: 10, windowSec: 60, key: "mfa-verify" } }, async ({ req, body, sq }) => {
  await completeMfa(sq, sessionToken(req)!, body.code, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  return { ok: true };
});
