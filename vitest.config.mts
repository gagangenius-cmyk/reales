import { defineConfig } from "vitest/config";
import path from "node:path";

const p = (s: string) => path.resolve(__dirname, s);

export default defineConfig({
  resolve: {
    alias: {
      "@/": p("apps/web") + "/",
      "@reales/database": p("packages/database/src/index.ts"),
      "@reales/domain": p("packages/domain/src/index.ts"),
      "@reales/auth": p("packages/auth/src/index.ts"),
      "@reales/rbac": p("packages/rbac/src/index.ts"),
      "@reales/events": p("packages/events/src/index.ts"),
      "@reales/observability": p("packages/observability/src/index.ts"),
      "@reales/validation": p("packages/validation/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
