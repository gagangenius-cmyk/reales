import { confirmTotpEnrollment, isMfaEnrolled, markSessionMfaVerified } from "@reales/auth";
import { recordAudit } from "@reales/database";
import { mfaCodeSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ auth: "pending-mfa", body: mfaCodeSchema, limit: { limit: 10, windowSec: 60, key: "mfa-confirm" } }, async ({ ctx, body, sq }) => {
  const wasEnrolled = await isMfaEnrolled(sq, ctx.tenantId, ctx.userId);
  const r = await confirmTotpEnrollment(sq, ctx.tenantId, ctx.userId, body.code);
  await markSessionMfaVerified(sq, ctx.tenantId, ctx.sessionId);
  const action = wasEnrolled ? "mfa.replaced" : "mfa.enrolled";
  await sq.transaction((tx) => recordAudit(sq, tx, { tenantId: ctx.tenantId, actorId: ctx.userId, action, entityType: "user", entityId: ctx.userId, correlationId: ctx.correlationId, ip: ctx.ip }));
  await sq.query("INSERT INTO security_events (id, tenant_id, user_id, type, created_at) VALUES (UUID(), :t, :u, :type, NOW(3))", { replacements: { t: ctx.tenantId, u: ctx.userId, type: action } });
  return { recoveryCodes: r.recoveryCodes };
});
