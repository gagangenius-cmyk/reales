import { NextResponse } from "next/server";
import { getSequelize } from "@reales/database";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getSequelize().query("SELECT 1");
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "degraded" }, { status: 503 });
  }
}
