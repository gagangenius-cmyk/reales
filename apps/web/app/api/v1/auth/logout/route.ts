import { NextResponse } from "next/server";
import { logout } from "@reales/auth";
import { api, clearSessionCookie, SESSION_COOKIE } from "@/lib/api";

export const POST = api({ auth: "none" }, async ({ req, sq }) => {
  await logout(sq, req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
});
