import { NextResponse } from "next/server";
import { login } from "@reales/auth";
import { loginSchema } from "@reales/validation";
import { api, setSessionCookie, clientIp } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

export const POST = api({ auth: "none", body: loginSchema, limit: { limit: 20, windowSec: 60, key: "login-ip" } }, async ({ req, body, sq }) => {
  // Also throttle per tenant+account so a distributed guess against one account is slowed down.
  const acct = await rateLimit(`login-acct:${body.tenant}:${body.email.toLowerCase()}`, 10, 60);
  if (!acct.allowed) {
    return NextResponse.json({ error: { code: "rate_limited", message: "Too many attempts" } }, { status: 429, headers: { "retry-after": "60" } });
  }
  const r = await login(sq, { tenantSlug: body.tenant, email: body.email, password: body.password, ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  const res = NextResponse.json({ status: r.status });
  setSessionCookie(res, r.token);
  return res;
});
