import type { NextConfig } from "next";
import path from "node:path";

// The monorepo keeps a single .env at the repo root (Next only reads apps/web/.env by default).
// On a hosting platform the variables come from the project settings and there is no .env file (or no dotenv package): this must never break the build.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config({ path: path.join(__dirname, "../../.env") });
} catch { /* variables are provided by the environment */ }

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `img-src 'self' data: blob: https://*.tile.openstreetmap.org${process.env.NEXT_PUBLIC_MAP_TILES ? ` ${new URL(process.env.NEXT_PUBLIC_MAP_TILES.replace(/\{[a-z]\}/g, "x")).origin}` : ""}`,
      "style-src 'self' 'unsafe-inline'",
      // Next.js inline bootstrap scripts; tighten with nonces once the UI surface grows.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, "../../"),
  transpilePackages: ["@reales/database", "@reales/domain", "@reales/auth", "@reales/rbac", "@reales/events", "@reales/observability", "@reales/validation"],
  // Files that are loaded dynamically (native argon2 binary, driver internals) are invisible to static tracing: include them explicitly.
  outputFileTracingIncludes: { "/**": ["../../node_modules/mysql2/**/*", "../../node_modules/sequelize/**/*", "../../node_modules/argon2/**/*", "../../node_modules/node-gyp-build/**/*", "../../node_modules/@phc/**/*"] },
  serverExternalPackages: ["sequelize", "mysql2", "argon2", "pino", "otplib", "ioredis"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
