import { NextResponse } from "next/server";
import { getSequelize } from "@reales/database";
import { logger } from "@reales/observability";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getSequelize().query("SELECT 1");
    return NextResponse.json({ status: "ok" });
  } catch (e) {
    // The response stays generic (it is public); the cause goes to the server log, e.g. ECONNREFUSED, ETIMEDOUT, ER_ACCESS_DENIED_ERROR, ER_NO_SUCH_TABLE.
    logger.error({ code: (e as any)?.parent?.code ?? (e as any)?.original?.code ?? (e as any)?.code, host: process.env.DB_HOST ? "set" : "MISSING" }, "health check: database unreachable");
    return NextResponse.json({ status: "degraded" }, { status: 503 });
  }
}
