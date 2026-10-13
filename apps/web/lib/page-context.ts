import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, resolveRequestContext } from "@reales/auth";
import { getSequelize, RequestContext } from "@reales/database";
import { SESSION_COOKIE } from "./api";

/** For server components: resolve the tenant context from the session cookie or redirect to the right auth step. */
export async function requireContext(): Promise<RequestContext> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const h = await headers();
  try {
    return await resolveRequestContext(getSequelize(), token, {
      correlationId: h.get("x-correlation-id") ?? `corr_page_${Date.now()}`,
      ip: h.get("x-real-ip"),
      userAgent: h.get("user-agent"),
    });
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.code === "mfa_enrollment_required") redirect("/mfa/setup");
      if (e.code === "mfa_required") redirect("/login?mfa=1");
      redirect("/login");
    }
    throw e;
  }
}
