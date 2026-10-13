import { NextResponse } from "next/server";
import { buildPortalFeed } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

/** Manual-upload feed built from the latest immutable snapshots. */
export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => {
  const feed = await buildPortalFeed(sq, ctx, uuid.parse(params.id));
  return new NextResponse(feed.body, { headers: { "content-type": feed.format === "xml" ? "application/xml; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store" } });
});
