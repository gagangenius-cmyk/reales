import type { NextConfig } from "next";
import path from "node:path";
import dotenv from "dotenv";

// The monorepo keeps a single .env at the repo root (Next only reads apps/web/.env by default).
dotenv.config({ path: path.join(__dirname, "../../.env") });

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
      "img-src 'self' data: blob:",
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
  serverExternalPackages: ["sequelize", "mysql2", "argon2", "pino", "otplib", "ioredis"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
