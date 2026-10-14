import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import nextConfig from "../../apps/web/next.config";

const API_ROOT = path.join(__dirname, "../../apps/web/app/api");
function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? routes(p) : f === "route.ts" ? [p] : [];
  });
}

describe("web security configuration", () => {
  it("sends the hardening headers on every path", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe("/:path*");
    const h = Object.fromEntries(rules[0]!.headers.map((x) => [x.key, x.value]));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=\d{8,}/);
    expect(h["Referrer-Policy"]).toBeTruthy();
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(h["Content-Security-Policy"]).not.toMatch(/script-src[^;]*\*/);
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("routes every API handler through the shared api() wrapper (auth, origin check, rate limit, error mapping)", () => {
    const files = routes(API_ROOT);
    expect(files.length).toBeGreaterThan(150);
    const bare: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const exportsHandlers = /export (const|async function) (GET|POST|PUT|PATCH|DELETE)\b/.test(src);
      if (exportsHandlers && !/\bapi(<|\()/.test(src) && !/ingestWebhook|webhook/i.test(src) && !/health/.test(f)) bare.push(path.relative(API_ROOT, f));
    }
    expect(bare).toEqual([]);
  });

  it("only the documented routes opt out of authentication", () => {
    const open: string[] = [];
    for (const f of routes(API_ROOT)) if (/auth:\s*"none"/.test(readFileSync(f, "utf8"))) open.push(path.relative(API_ROOT, f).replace(/\\/g, "/"));
    // Webhook receivers do not use the session at all: they authenticate by verifying the provider's signature (covered in messaging-webhooks and documents tests).
    expect(open.sort()).toEqual(["v1/auth/invite/accept/route.ts", "v1/auth/login/route.ts", "v1/auth/logout/route.ts", "v1/auth/password/forgot/route.ts", "v1/auth/password/reset/route.ts", "v1/auth/sso/begin/route.ts", "v1/auth/sso/callback/route.ts", "v1/preferences/language/route.ts"]);
    for (const p of open.filter((x) => !x.includes("logout"))) expect(readFileSync(path.join(API_ROOT, p), "utf8")).toMatch(/limit:/);
  });
});
