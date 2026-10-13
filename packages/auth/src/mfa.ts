import { authenticator } from "otplib";
import { randomBytes } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { decryptField, encryptField, sha256, safeEqualHex } from "./crypto";
import { AuthError } from "./errors";

const STEP = 30_000;

export function newTotpSecret() {
  return authenticator.generateSecret(20);
}

export function otpauthUrl(email: string, secret: string, issuer = "Reales CRM") {
  return authenticator.keyuri(email, issuer, secret);
}

/** Returns the matched time-step when the code is valid (window +-1), else null. */
export function matchTotpStep(secret: string, code: string, now = Date.now()): number | null {
  for (const d of [0, -1, 1]) {
    const at = now + d * STEP;
    if (authenticator.clone({ epoch: at, window: 0 }).check(code, secret)) return Math.floor(at / STEP);
  }
  return null;
}

export function generateRecoveryCodes(n = 10) {
  const codes = Array.from({ length: n }, () => `${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}`);
  return { codes, hashes: codes.map(sha256) };
}

interface MfaRow {
  id: string;
  secret_encrypted: string;
  verified_at: Date | null;
  last_used_step: string | null;
  recovery_codes_hash: string | string[] | null;
}

async function getMethod(sq: Sequelize, tenantId: string, userId: string, verifiedOnly: boolean) {
  const rows = await sq.query<MfaRow>(
    `SELECT id, secret_encrypted, verified_at, last_used_step, recovery_codes_hash FROM mfa_methods
      WHERE tenant_id=:tenantId AND user_id=:userId ${verifiedOnly ? "AND verified_at IS NOT NULL" : ""} ORDER BY created_at DESC LIMIT 1`,
    { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
  );
  return rows[0] ?? null;
}

export async function isMfaEnrolled(sq: Sequelize, tenantId: string, userId: string) {
  return !!(await getMethod(sq, tenantId, userId, true));
}

export async function beginTotpEnrollment(sq: Sequelize, tenantId: string, userId: string, email: string) {
  await sq.query("DELETE FROM mfa_methods WHERE tenant_id=:tenantId AND user_id=:userId AND verified_at IS NULL", {
    replacements: { tenantId, userId },
  });
  const secret = newTotpSecret();
  await sq.query(
    "INSERT INTO mfa_methods (id, tenant_id, user_id, type, secret_encrypted, created_at, updated_at) VALUES (UUID(), :tenantId, :userId, 'totp', :enc, NOW(3), NOW(3))",
    { replacements: { tenantId, userId, enc: encryptField(secret) } },
  );
  return { secret, otpauthUrl: otpauthUrl(email, secret) };
}

/** Confirms enrolment with a first valid code; returns one-time recovery codes (only hashes are stored). */
export async function confirmTotpEnrollment(sq: Sequelize, tenantId: string, userId: string, code: string) {
  const m = await getMethod(sq, tenantId, userId, false);
  if (!m || m.verified_at) throw new AuthError("mfa_invalid", "No pending enrolment");
  const step = matchTotpStep(decryptField(m.secret_encrypted), code);
  if (step === null) throw new AuthError("mfa_invalid");
  const { codes, hashes } = generateRecoveryCodes();
  await sq.query(
    "UPDATE mfa_methods SET verified_at=NOW(3), last_used_step=:step, recovery_codes_hash=:h WHERE id=:id AND tenant_id=:tenantId",
    { replacements: { step, h: JSON.stringify(hashes), id: m.id, tenantId } },
  );
  return { recoveryCodes: codes };
}

/** Verify a TOTP (with replay protection) or a single-use recovery code. */
export async function verifyMfaCode(sq: Sequelize, tenantId: string, userId: string, code: string): Promise<boolean> {
  const m = await getMethod(sq, tenantId, userId, true);
  if (!m) return false;
  const trimmed = code.trim();
  if (/^[0-9a-f]{6}-[0-9a-f]{6}$/i.test(trimmed)) {
    const list: string[] = typeof m.recovery_codes_hash === "string" ? JSON.parse(m.recovery_codes_hash) : (m.recovery_codes_hash ?? []);
    const h = sha256(trimmed.toLowerCase());
    const idx = list.findIndex((x) => safeEqualHex(x, h));
    if (idx === -1) return false;
    list.splice(idx, 1);
    await sq.query("UPDATE mfa_methods SET recovery_codes_hash=:h WHERE id=:id AND tenant_id=:tenantId", {
      replacements: { h: JSON.stringify(list), id: m.id, tenantId },
    });
    return true;
  }
  const step = matchTotpStep(decryptField(m.secret_encrypted), trimmed);
  if (step === null) return false;
  if (m.last_used_step !== null && step <= Number(m.last_used_step)) return false; // replay
  // Atomic compare-and-set so two concurrent submissions of the same code cannot both pass.
  const [, meta] = (await sq.query(
    "UPDATE mfa_methods SET last_used_step=:step WHERE id=:id AND tenant_id=:tenantId AND (last_used_step IS NULL OR last_used_step < :step)",
    { replacements: { step, id: m.id, tenantId } },
  )) as unknown as [unknown, { affectedRows?: number } | number];
  const affected = typeof meta === "number" ? meta : meta?.affectedRows ?? 0;
  return affected > 0;
}
