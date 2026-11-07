import { NextResponse } from "next/server";
import { getSequelize } from "@reales/database";
import { backgroundStatus } from "@reales/domain";

export const dynamic = "force-dynamic";

/**
 * For an uptime monitor: 200 when the scheduler and worker have both reported in during the last 5 minutes, 503 when either has gone quiet.
 * Public and read-only; it reveals only service names and ages, never data.
 */
export async function GET() {
  try {
    const services = await backgroundStatus(getSequelize());
    const ok = services.every((s) => s.healthy);
    return NextResponse.json({ status: ok ? "ok" : "degraded", services }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "degraded" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
