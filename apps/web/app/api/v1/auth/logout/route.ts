import { NextResponse } from "next/server";
import { logout } from "@reales/auth";
import { api, clearSessionCookie, sessionToken } from "@/lib/api";

export const POST = api({ auth: "none" }, async ({ req, sq }) => {
  await logout(sq, sessionToken(req));
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
});
