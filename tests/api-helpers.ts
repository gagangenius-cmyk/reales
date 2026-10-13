import { NextRequest } from "next/server";
import { PASSWORD, totpNow } from "./helpers";
import { POST as loginRoute } from "@/app/api/v1/auth/login/route";
import { POST as enrollRoute } from "@/app/api/v1/auth/mfa/enroll/route";
import { POST as enrollConfirmRoute } from "@/app/api/v1/auth/mfa/enroll/confirm/route";

export const ORIGIN = "http://localhost:3000";

export interface CallOpts { body?: unknown; form?: FormData; raw?: string; cookie?: string; origin?: string | null; headers?: Record<string, string>; params?: Record<string, string> }

/** Invoke a Next route handler directly with a real NextRequest (no server needed). */
export async function call(handler: (r: NextRequest, c?: any) => Promise<Response>, method: string, path: string, o: CallOpts = {}) {
  const headers: Record<string, string> = { host: "localhost:3000", ...(o.form ? {} : { "content-type": "application/json" }), ...(o.headers ?? {}) };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.cookie) headers.cookie = `reales_session=${o.cookie}`;
  const body = o.form ?? (o.raw !== undefined ? o.raw : o.body === undefined ? undefined : JSON.stringify(o.body));
  const req = new NextRequest(`${ORIGIN}${path}`, { method, headers, body });
  const res = await handler(req, { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body (feeds) */ }
  return { status: res.status, json, text, res };
}

export const sessionOf = (res: Response) => /reales_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

export async function loginAs(slug: string, email: string, password = PASSWORD) {
  const r = await call(loginRoute, "POST", "/api/v1/auth/login", { body: { tenant: slug, email, password } });
  return { ...r, token: sessionOf(r.res) };
}

/** Log in as a user whose role requires MFA and complete enrolment, returning a fully verified session cookie + TOTP secret. */
export async function mfaSession(slug: string, email: string, password = PASSWORD) {
  const l = await loginAs(slug, email, password);
  const enroll = await call(enrollRoute, "POST", "/api/v1/auth/mfa/enroll", { cookie: l.token });
  await call(enrollConfirmRoute, "POST", "/api/v1/auth/mfa/enroll/confirm", { cookie: l.token, body: { code: totpNow(enroll.json.secret) } });
  return { token: l.token!, secret: enroll.json.secret as string };
}

export const adminSession = mfaSession;
