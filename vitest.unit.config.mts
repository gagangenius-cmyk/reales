import { defineConfig } from "vitest/config";
import path from "node:path";

const p = (s: string) => path.resolve(__dirname, s);

/** Pure logic only: no database, no Docker. Run with `npm run test:unit`. */
export default defineConfig({
  resolve: {
    alias: {
      "@reales/database": p("packages/database/src/index.ts"),
      "@reales/domain": p("packages/domain/src/index.ts"),
      "@reales/auth": p("packages/auth/src/index.ts"),
      "@reales/rbac": p("packages/rbac/src/index.ts"),
      "@reales/events": p("packages/events/src/index.ts"),
      "@reales/observability": p("packages/observability/src/index.ts"),
      "@reales/validation": p("packages/validation/src/index.ts"),
    },
  },
  test: { include: ["tests/unit/**/*.test.ts", "tests/security/**/*.test.ts"], setupFiles: ["tests/setup-env.ts"] },
});
