import * as mysql2 from "mysql2";
import { Sequelize } from "sequelize";
import { logger } from "@reales/observability";

export interface DbConfig {
  host: string; port: number; user: string; password: string; database: string; poolMax?: number; ssl?: false | { rejectUnauthorized: boolean };
}

export function dbConfigFromEnv(test = false): DbConfig {
  const e = process.env;
  return {
    host: e.DB_HOST ?? "127.0.0.1",
    port: Number(e.DB_PORT ?? 3307),
    user: e.DB_USER ?? "reales",
    password: e.DB_PASSWORD ?? "reales_dev_password",
    database: test ? (e.DB_TEST_NAME ?? "reales_test") : (e.DB_NAME ?? "reales"),
    // Managed/remote databases must be reached over TLS: DB_SSL=1 turns it on and verifies the certificate. DB_SSL_INSECURE=1 encrypts but skips
    // certificate verification (only for hosts with self-signed certificates; prefer fixing the certificate).
    ssl: e.DB_SSL === "1" ? { rejectUnauthorized: e.DB_SSL_INSECURE !== "1" } : false,
    // Serverless platforms start many small instances: keep each one's pool tiny (DB_POOL_MAX=2) so the database is not exhausted.
    poolMax: e.DB_POOL_MAX ? Number(e.DB_POOL_MAX) : undefined,
  };
}

let shared: Sequelize | null = null;

export function createSequelize(cfg: DbConfig = dbConfigFromEnv(process.env.NODE_ENV === "test")): Sequelize {
  return new Sequelize(cfg.database, cfg.user, cfg.password, {
    host: cfg.host,
    port: cfg.port,
    dialect: "mysql",
    // Sequelize normally loads the driver with a dynamic require that serverless bundlers cannot trace ("Please install mysql2 package manually").
    dialectModule: mysql2,
    timezone: "+00:00",
    logging: process.env.DB_LOG === "1" ? (sql) => logger.debug({ sql }) : false,
    pool: { max: cfg.poolMax ?? 10, min: 0, idle: 10000 },
    ...(cfg.ssl ? { dialectOptions: { ssl: cfg.ssl } } : {}),
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
