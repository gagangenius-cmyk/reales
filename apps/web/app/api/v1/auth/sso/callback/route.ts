import { NextResponse } from "next/server";
import { completeSso } from "@reales/domain";
import { ssoCallbackQuery } from "@reales/validation";
import { api, clientIp, setSessionCookie } from "@/lib/api";

export const GET = api({ auth: "none", query: ssoCallbackQuery, limit: { limit: 30, windowSec: 60, key: "sso-callback-ip" } }, async ({ req, sq, query }) => {
  const r = await completeSso(sq, { state: query.state, code: query.code, ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  const origin = process.env.APP_URL ?? req.nextUrl.origin;
  const dest = r.status === "ok" ? "/dashboard" : r.status === "mfa_enrollment_required" ? "/mfa/setup" : "/login?mfa=1";
  const res = NextResponse.redirect(new URL(dest, origin), 303);
  setSessionCookie(res, r.token);
  return res;
});
