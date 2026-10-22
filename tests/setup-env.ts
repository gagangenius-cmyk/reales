import "dotenv/config";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.MIGRATE_QUIET = "1";
process.env.AUTH_PEPPER ??= "test-pepper";
process.env.FIELD_ENCRYPTION_KEY ??= "0".repeat(64);
// Tests always use the local-disk store, even when the developer's .env points at an S3 bucket.
for (const k of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) delete process.env[k];
