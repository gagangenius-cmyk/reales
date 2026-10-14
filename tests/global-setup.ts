import "dotenv/config";

/** Build the test schema from zero once per run (this doubles as the "migrations reproducible from zero" check). */
export default async function setup() {
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  process.env.MIGRATE_QUIET = "1";
  const { createSequelize, dbConfigFromEnv } = await import("../packages/database/src/connection");
  const { resetDatabase } = await import("../packages/database/src/migrator");
  const sq = createSequelize(dbConfigFromEnv(true));
  try {
    await resetDatabase(sq);
  } finally {
    await sq.close();
  }
}
