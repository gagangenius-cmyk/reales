import path from "node:path";
import { pathToFileURL } from "node:url";
import { Sequelize } from "sequelize";
import { SequelizeStorage, Umzug } from "umzug";

/**
 * Opt-in (MIGRATE_ALLOW_NO_TRIGGERS=1) for hosts that refuse CREATE TRIGGER without SUPER (MySQL error 1419, binary logging on).
 * Only that one error is tolerated, and loudly: the append-only guarantee then rests on the application never updating those tables.
 */
function triggerTolerant(sequelize: Sequelize): Sequelize {
  if (process.env.MIGRATE_ALLOW_NO_TRIGGERS !== "1") return sequelize;
  return new Proxy(sequelize, {
    get(target, prop, receiver) {
      if (prop !== "query") return Reflect.get(target, prop, receiver);
      return async (sql: unknown, ...rest: unknown[]) => {
        try {
          return await (target.query as (...a: unknown[]) => Promise<unknown>).call(target, sql, ...rest);
        } catch (e) {
          const err = e as { parent?: { errno?: number }; original?: { errno?: number } };
          if ((err.parent?.errno ?? err.original?.errno) === 1419 && typeof sql === "string" && /^\s*CREATE TRIGGER/i.test(sql)) {
            console.warn(`WARNING: append-only trigger skipped (host denies CREATE TRIGGER): ${sql.slice(0, 70)}...`);
            return [[], 0];
          }
          throw e;
        }
      };
    },
  });
}

export function createMigrator(sequelize: Sequelize, dir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations")) {
  const ctx = { context: sequelize.getQueryInterface(), sequelize: triggerTolerant(sequelize) };
  return new Umzug({
    migrations: {
      glob: ["2*.ts", { cwd: dir, ignore: ["_*"] }],
      resolve: ({ name, path: file }) => ({
        name,
        up: async () => (await import(pathToFileURL(file!).href)).up(ctx),
        down: async () => (await import(pathToFileURL(file!).href)).down(ctx),
      }),
    },
    context: ctx,
    storage: new SequelizeStorage({ sequelize, tableName: "schema_migrations" }),
    logger: process.env.MIGRATE_QUIET === "1" ? undefined : console,
  });
}

/** Drop every table and re-run all migrations (dev/test only). */
export async function resetDatabase(sequelize: Sequelize) {
  const qi = sequelize.getQueryInterface();
  await sequelize.query("SET FOREIGN_KEY_CHECKS = 0");
  const tables = (await qi.showAllTables()) as unknown as string[];
  for (const t of tables) await sequelize.query(`DROP TABLE IF EXISTS \`${t}\``);
  await sequelize.query("SET FOREIGN_KEY_CHECKS = 1");
  await createMigrator(sequelize).up();
}
