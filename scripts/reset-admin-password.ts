import "dotenv/config";
import { randomBytes } from "node:crypto";
import { closeSequelize, getSequelize } from "../packages/database/src";
import { hashPassword } from "../packages/auth/src";

/** Sets a new password for ADMIN_EMAIL (generated and printed once unless ADMIN_PASSWORD is set). */
async function main() {
  const email = process.env.ADMIN_EMAIL;
  if (!email) throw new Error("Set ADMIN_EMAIL");
  const password = process.env.ADMIN_PASSWORD || randomBytes(9).toString("base64url") + "aA1!";
  const hash = await hashPassword(password);
  const [, meta]: any = await getSequelize().query("UPDATE users SET password_hash=:hash, failed_login_count=0, locked_until=NULL, status='active' WHERE email=:email", { replacements: { hash, email } });
  if (!meta?.affectedRows && !meta?.changedRows) throw new Error(`No user ${email}`);
  console.log(`Password for ${email}: ${password}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); }).finally(() => closeSequelize());
