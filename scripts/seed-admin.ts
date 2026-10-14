import "dotenv/config";
import { randomBytes } from "node:crypto";
import { QueryTypes } from "sequelize";
import { closeSequelize, getSequelize } from "../packages/database/src";
import { bootstrapTenant } from "../packages/domain/src";

/**
 * Creates one workspace with an admin user and nothing else (no demo data), so it is safe for a real database.
 * Configure with env vars: ADMIN_EMAIL, ADMIN_PASSWORD (optional, generated if empty), TENANT_NAME, TENANT_SLUG.
 */
async function main() {
  const sq = getSequelize();
  const email = process.env.ADMIN_EMAIL;
  if (!email) throw new Error("Set ADMIN_EMAIL (e.g. ADMIN_EMAIL=you@company.com npm run db:seed:admin)");
  const slug = process.env.TENANT_SLUG ?? "main";
  const name = process.env.TENANT_NAME ?? "My Company";
  const [existing] = await sq.query("SELECT id FROM tenants WHERE slug=:slug", { replacements: { slug }, type: QueryTypes.SELECT });
  if (existing) { console.log(`Workspace "${slug}" already exists - nothing to do.`); return; }

  const password = process.env.ADMIN_PASSWORD || randomBytes(9).toString("base64url") + "aA1!";
  await bootstrapTenant(sq, { name, slug, adminEmail: email, adminPassword: password });
  console.log(`\nCreated workspace "${slug}" (${name})`);
  console.log(`  Workspace: ${slug}\n  Email:     ${email}\n  Password:  ${password}`);
  console.log("MFA enrolment is required on first sign-in. Change the password afterwards.\n");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => closeSequelize());
