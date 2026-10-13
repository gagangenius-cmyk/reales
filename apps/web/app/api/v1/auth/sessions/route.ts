import { listSessions, revokeAllSessions } from "@reales/auth";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ sessions: await listSessions(sq, ctx.tenantId, ctx.userId), current: ctx.sessionId }));

/** Sign out everywhere else. */
export const DELETE = api({}, async ({ ctx, sq }) => {
  await revokeAllSessions(sq, ctx.tenantId, ctx.userId, ctx.sessionId);
  return { ok: true };
});
