import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { Sequelize } from "sequelize";
import { ZodError, ZodTypeAny, z } from "zod";
import { AuthError, resolveRequestContext } from "@reales/auth";
import { getSequelize, RequestContext, TenantViolationError } from "@reales/database";
import { ConflictError, DealBlockedError, DocumentIntegrityError, DuplicateContactError, IdempotencyError, LeaseNotActivatableError, ListingNotPublishableError, NotFoundError, MissingVariableError, QuotaExceededError, TemplateInvalidError, UploadRejectedError, WorkflowInvalidError, withIdempotency } from "@reales/domain";
import { logger, runWithCorrelation } from "@reales/observability";
import { ForbiddenError } from "@reales/rbac";
import { rateLimit } from "./rate-limit";

export const SESSION_COOKIE = "reales_session";
const SESSION_MAX_AGE = 8 * 60 * 60;

export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });
}
export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0, secure: process.env.NODE_ENV === "production" });
}

export function clientIp(req: NextRequest): string | null {
  if (process.env.TRUST_PROXY === "1") return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return req.headers.get("x-real-ip") ?? null;
}

/** Reject cross-site state changes: browsers always send Origin on unsafe requests. */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export interface ApiArgs<P, B, Q> {
  req: NextRequest;
  ctx: RequestContext;
  params: P;
  body: B;
  query: Q;
  sq: Sequelize;
  correlationId: string;
}

export interface ApiOptions<B extends ZodTypeAny | undefined, Q extends ZodTypeAny | undefined> {
  /** required = full session; pending-mfa = session that still has to finish MFA; none = public. */
  auth?: "required" | "pending-mfa" | "none";
  body?: B;
  query?: Q;
  /** Honour the Idempotency-Key header (mutating endpoints that create things). */
  idempotent?: boolean;
  /** Per-IP limit (requests per window). Authenticated calls are additionally limited per tenant. */
  limit?: { limit: number; windowSec: number; key?: string };
}

type Out = Response | { status?: number; data?: unknown; headers?: Record<string, string> } | unknown;

export function errorResponse(e: unknown, correlationId: string): NextResponse {
  const body = (status: number, code: string, message: string, extra?: object) =>
    NextResponse.json({ error: { code, message, correlationId, ...extra } }, { status, headers: { "x-correlation-id": correlationId } });
  if (e instanceof ZodError) return body(400, "validation_error", "Invalid request", { issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  if (e instanceof AuthError) return body(e.status, e.code, e.message);
  if (e instanceof ForbiddenError) return body(403, "forbidden", e.message);
  if (e instanceof NotFoundError) return body(404, "not_found", e.message);
  if (e instanceof DuplicateContactError) return body(409, "duplicate_contact", e.message, { matchCount: e.matchCount, matches: e.visibleMatches });
  if (e instanceof ConflictError) return body(409, "conflict", e.message);
  if (e instanceof ListingNotPublishableError) return body(422, "listing_not_publishable", e.message, { evaluation: e.evaluation });
  if (e instanceof QuotaExceededError) return body(402, "quota_exceeded", e.message);
  if (e instanceof DealBlockedError) return body(422, "deal_blocked", e.message, { reasons: e.reasons });
  if (e instanceof TemplateInvalidError) return body(422, "template_invalid", e.message, { issues: e.issues });
  if (e instanceof WorkflowInvalidError) return body(422, "workflow_invalid", e.message, { issues: e.issues });
  if (e instanceof MissingVariableError) return body(422, "missing_variable", e.message, { missing: e.missing });
  if (e instanceof LeaseNotActivatableError) return body(422, "lease_not_activatable", e.message, { reasons: e.reasons });
  if (e instanceof UploadRejectedError) return body(422, "upload_rejected", e.message);
  if (e instanceof IdempotencyError) return body(e.status, "idempotency", e.message);
  if (e instanceof DocumentIntegrityError) {
    logger.error({ err: e }, "document integrity failure");
    return body(500, "integrity_error", "The stored document failed its integrity check");
  }
  if (e instanceof TenantViolationError) {
    logger.error({ err: e }, "tenant violation");
    return body(500, "internal_error", "Internal error");
  }
  if (e instanceof Error && /Password (must|needs)/.test(e.message)) return body(400, "weak_password", e.message);
  logger.error({ err: e }, "unhandled api error");
  return body(500, "internal_error", "Internal error");
}

/** Standard API handler: correlation id, origin check, rate limit, session -> context, validation, idempotency, error mapping. */
export function api<P = Record<string, string>, B extends ZodTypeAny | undefined = undefined, Q extends ZodTypeAny | undefined = undefined>(
  opts: ApiOptions<B, Q>,
  handler: (a: ApiArgs<P, B extends ZodTypeAny ? z.infer<B> : undefined, Q extends ZodTypeAny ? z.infer<Q> : undefined>) => Promise<Out>,
) {
  return async (req: NextRequest, route?: { params: Promise<P> }): Promise<Response> => {
    const incoming = req.headers.get("x-correlation-id");
    const correlationId = incoming && /^[A-Za-z0-9._-]{8,80}$/.test(incoming) ? incoming : `corr_${randomUUID()}`;
    return runWithCorrelation({ correlationId }, async () => {
      try {
        const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
        if (unsafe && !sameOrigin(req)) throw new ForbiddenError("Cross-origin request rejected");

        const ip = clientIp(req);
        if (opts.limit) {
          const r = await rateLimit(`${opts.limit.key ?? req.nextUrl.pathname}:${ip ?? "anon"}`, opts.limit.limit, opts.limit.windowSec);
          if (!r.allowed) {
            return NextResponse.json({ error: { code: "rate_limited", message: "Too many requests", correlationId } }, { status: 429, headers: { "retry-after": String(r.retryAfterSec), "x-correlation-id": correlationId } });
          }
        }

        const sq = getSequelize();
        let ctx = undefined as unknown as RequestContext;
        if ((opts.auth ?? "required") !== "none") {
          ctx = await resolveRequestContext(sq, req.cookies.get(SESSION_COOKIE)?.value, {
            correlationId, ip, userAgent: req.headers.get("user-agent"), allowPendingMfa: opts.auth === "pending-mfa",
          });
          // Tenant-aware rate limiting for authenticated traffic.
          const tr = await rateLimit(`tenant:${ctx.tenantId}`, 1200, 60);
          if (!tr.allowed) {
            return NextResponse.json({ error: { code: "rate_limited", message: "Tenant rate limit exceeded", correlationId } }, { status: 429, headers: { "retry-after": "60", "x-correlation-id": correlationId } });
          }
        }

        let body: unknown = undefined;
        if (opts.body) {
          let raw: unknown;
          try { raw = await req.json(); } catch { raw = undefined; }
          body = opts.body.parse(raw);
        }
        const query = opts.query ? opts.query.parse(Object.fromEntries(req.nextUrl.searchParams)) : undefined;
        const params = (route ? await route.params : {}) as P;

        const run = async () => {
          const out = (await handler({ req, ctx, params, body: body as never, query: query as never, sq, correlationId })) as Out;
          if (out instanceof Response) return { status: out.status, body: undefined as unknown, response: out };
          const o = out as { status?: number; data?: unknown; headers?: Record<string, string> } | undefined;
          const looksWrapped = !!o && typeof o === "object" && ("data" in o || "status" in o) && Object.keys(o).every((k) => ["status", "data", "headers"].includes(k));
          return { status: looksWrapped ? o!.status ?? 200 : 200, body: looksWrapped ? o!.data : out, headers: looksWrapped ? o!.headers : undefined };
        };

        const idemKey = opts.idempotent ? req.headers.get("idempotency-key") : null;
        let result: { status: number; body: unknown; replayed?: boolean; response?: Response; headers?: Record<string, string> };
        if (idemKey && ctx) {
          result = await withIdempotency(sq, ctx.tenantId, `${req.method} ${req.nextUrl.pathname}`, idemKey, body, async () => {
            const r = await run();
            return { status: r.status, body: r.body };
          });
        } else {
          result = await run();
        }
        if (result.response) {
          result.response.headers.set("x-correlation-id", correlationId);
          return result.response;
        }
        const res = NextResponse.json(result.body === undefined ? null : result.body, {
          status: result.status,
          headers: { "x-correlation-id": correlationId, "cache-control": "no-store", ...(result.headers ?? {}), ...(result.replayed ? { "idempotent-replayed": "true" } : {}) },
        });
        return res;
      } catch (e) {
        return errorResponse(e, correlationId);
      }
    });
  };
}
