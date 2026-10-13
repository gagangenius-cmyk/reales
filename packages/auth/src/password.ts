import argon2 from "argon2";

const pepper = () => {
  const v = process.env.AUTH_PEPPER;
  // A missing pepper must never silently produce hashes that later fail to verify (or verify under an empty secret).
  if (!v && process.env.NODE_ENV === "production") throw new Error("AUTH_PEPPER is required in production");
  return Buffer.from(v ?? "");
};
const opts = () => ({ type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1, secret: pepper() });

export const MIN_PASSWORD_LENGTH = 12;

export function assertPasswordPolicy(pw: string) {
  if (pw.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) throw new Error("Password needs upper and lower case letters and a digit");
}

export const hashPassword = (pw: string) => argon2.hash(pw, opts());

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw, { secret: pepper() });
  } catch {
    return false;
  }
}

let dummy: string | null = null;
/** Burn equivalent CPU for unknown users so response time does not reveal account existence. */
export async function dummyVerify(pw: string): Promise<void> {
  dummy ??= await hashPassword("dummy-password-for-timing-Aa1");
  await verifyPassword(dummy, pw);
}
