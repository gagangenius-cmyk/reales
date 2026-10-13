import "dotenv/config";
process.env.NODE_ENV = "test";
process.env.MIGRATE_QUIET = "1";
process.env.AUTH_PEPPER ??= "test-pepper";
process.env.FIELD_ENCRYPTION_KEY ??= "0".repeat(64);
