import { NextResponse } from "next/server";
import { completeGoogleConnect } from "@reales/domain";
import { googleCallbackQuery } from "@reales/validation";
import { api } from "@/lib/api";

const origin = (reqOrigin: string) => (process.env.PUBLIC_BASE_URL ?? process.env.APP_URL ?? reqOrigin).replace(/\/$/, "");

/** Google sends the person back here. The state is bound to the signed-in user, so a link followed by someone else is refused. */
export const GET = api({ query: googleCallbackQuery }, async ({ req, ctx, sq, query }) => {
  const base = origin(req.nextUrl.origin);
  if (query.error || !query.code || !query.state) return NextResponse.redirect(`${base}/google?error=${encodeURIComponent(query.error === "access_denied" ? "Google access was not granted" : "Google sign-in was cancelled")}`);
  try {
    await completeGoogleConnect(sq, ctx, { code: query.code, state: query.state });
    return NextResponse.redirect(`${base}/google?connected=1`);
  } catch (e) {
    return NextResponse.redirect(`${base}/google?error=${encodeURIComponent(e instanceof Error ? e.message.slice(0, 160) : "Could not connect Google")}`);
  }
});
