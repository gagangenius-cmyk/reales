import path from "node:path";
import { pathToFileURL } from "node:url";
import { Sequelize } from "sequelize";
import { SequelizeStorage, Umzug } from "umzug";

export function createMigrator(sequelize: Sequelize, dir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations")) {
  const ctx = { context: sequelize.getQueryInterface(), sequelize };
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
