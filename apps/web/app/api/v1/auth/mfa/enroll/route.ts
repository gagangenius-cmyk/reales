import { QueryTypes } from "sequelize";
import QRCode from "qrcode";
import { beginTotpEnrollment, isMfaEnrolled, requireStepUp } from "@reales/auth";
import { ForbiddenError } from "@reales/rbac";
import { api } from "@/lib/api";

/**
 * Start TOTP enrolment. A session that has not yet completed MFA may only enrol when the user has no
 * verified factor (first-time setup). Replacing an existing factor needs a fully verified session + step-up,
 * so a stolen password alone can never swap the second factor.
 */
export const POST = api({ auth: "pending-mfa", limit: { limit: 10, windowSec: 60, key: "mfa-enroll" } }, async ({ ctx, sq }) => {
  if (await isMfaEnrolled(sq, ctx.tenantId, ctx.userId)) {
    const [s] = await sq.query<{ mfa_verified_at: Date | null }>("SELECT mfa_verified_at FROM sessions WHERE id=:id AND tenant_id=:t", { replacements: { id: ctx.sessionId, t: ctx.tenantId }, type: QueryTypes.SELECT });
    if (!s?.mfa_verified_at) throw new ForbiddenError("Complete MFA before changing your second factor");
    requireStepUp(ctx);
  }
  const [u] = await sq.query<{ email: string }>("SELECT email FROM users WHERE id=:u AND tenant_id=:t", { replacements: { u: ctx.userId, t: ctx.tenantId }, type: QueryTypes.SELECT });
  const r = await beginTotpEnrollment(sq, ctx.tenantId, ctx.userId, u!.email);
  return { secret: r.secret, otpauthUrl: r.otpauthUrl, qrSvg: await QRCode.toString(r.otpauthUrl, { type: "svg", margin: 1 }) };
});
