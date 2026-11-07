import { disconnectGoogle, getGoogleStatus } from "@reales/domain";
import { api } from "@/lib/api";

/** Connection status only. Tokens are never part of any response. */
export const GET = api({}, async ({ ctx, sq }) => getGoogleStatus(sq, ctx));
export const DELETE = api({}, async ({ ctx, sq }) => {
  await disconnectGoogle(sq, ctx);
  return { ok: true };
});
