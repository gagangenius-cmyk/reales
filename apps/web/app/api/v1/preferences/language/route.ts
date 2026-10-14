import { NextResponse } from "next/server";
import { z } from "@reales/validation";
import { api } from "@/lib/api";
import { LANG_COOKIE } from "@/lib/i18n-dictionary";

/** A display preference only: no account needed, nothing sensitive in the cookie. */
export const POST = api({ auth: "none", body: z.object({ lang: z.enum(["en", "ar"]) }).strict(), limit: { limit: 60, windowSec: 60, key: "lang-ip" } }, async ({ body }) => {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(LANG_COOKIE, body.lang, { path: "/", maxAge: 365 * 24 * 3600, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  return res;
});
