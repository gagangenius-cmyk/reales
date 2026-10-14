import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeSequelize, getSequelize } from "../packages/database/src";

/**
 * Installs the append-only triggers on a database that was migrated while the host still denied CREATE TRIGGER
 * (MIGRATE_ALLOW_NO_TRIGGERS=1). It replays only the CREATE TRIGGER statements of every migration: all other
 * statements are skipped, and triggers that already exist are left alone. Safe to run repeatedly.
 */
async function main() {
  const sq = getSequelize();
  const dir = path.resolve(process.cwd(), "migrations");
  const noop: any = new Proxy(() => undefined, { get: () => noop, apply: async () => [] });
  let created = 0, existing = 0;
  const fake: any = new Proxy(sq, {
    get(target, prop, receiver) {
      if (prop !== "query") return Reflect.get(target, prop, receiver);
      return async (sql: unknown, ...rest: unknown[]) => {
        if (typeof sql !== "string" || !/^\s*CREATE TRIGGER/i.test(sql)) return [[], 0];
        try { await (target.query as any).call(target, sql, ...rest); created++; } catch (e: any) {
          const errno = e?.parent?.errno ?? e?.original?.errno;
          if (errno === 1359) existing++; else throw e;
        }
        return [[], 0];
      };
    },
  });
  for (const f of readdirSync(dir).filter((x) => /^2.*\.ts$/.test(x)).sort()) {
    if (!/TRIGGER|appendOnly/.test(readFileSync(path.join(dir, f), "utf8"))) continue;
    await (await import(pathToFileURL(path.join(dir, f)).href)).up({ context: noop, sequelize: fake });
  }
  const [rows]: any = await sq.query("SELECT COUNT(*) c FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
  console.log(`Triggers created: ${created}, already present: ${existing}, total in database: ${rows[0].c}`);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); }).finally(() => closeSequelize());
