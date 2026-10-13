import { Sequelize } from "sequelize";
import { logger } from "@reales/observability";

export interface DbConfig {
  host: string; port: number; user: string; password: string; database: string; poolMax?: number;
}

export function dbConfigFromEnv(test = false): DbConfig {
  const e = process.env;
  return {
    host: e.DB_HOST ?? "127.0.0.1",
    port: Number(e.DB_PORT ?? 3307),
    user: e.DB_USER ?? "reales",
    password: e.DB_PASSWORD ?? "reales_dev_password",
    database: test ? (e.DB_TEST_NAME ?? "reales_test") : (e.DB_NAME ?? "reales"),
  };
}

let shared: Sequelize | null = null;

export function createSequelize(cfg: DbConfig = dbConfigFromEnv(process.env.NODE_ENV === "test")): Sequelize {
  return new Sequelize(cfg.database, cfg.user, cfg.password, {
    host: cfg.host,
    port: cfg.port,
    dialect: "mysql",
    timezone: "+00:00",
    logging: process.env.DB_LOG === "1" ? (sql) => logger.debug({ sql }) : false,
    pool: { max: cfg.poolMax ?? 10, min: 0, idle: 10000 },
    define: { underscored: true, timestamps: true },
  });
}

/** Process-wide connection (Next.js hot reload safe via globalThis). */
export function getSequelize(): Sequelize {
  const g = globalThis as unknown as { __realesSequelize?: Sequelize };
  if (!g.__realesSequelize) g.__realesSequelize = createSequelize();
  shared = g.__realesSequelize;
  return shared;
}

export async function closeSequelize(): Promise<void> {
  const g = globalThis as unknown as { __realesSequelize?: Sequelize };
  if (g.__realesSequelize) {
    await g.__realesSequelize.close();
    g.__realesSequelize = undefined;
  }
}

/** MySQL DATETIME(3) literal in UTC. Sequelize raw-query Date replacements drop milliseconds, so format explicitly. */
export function mysqlDate(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}
