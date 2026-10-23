import { myCalendarFeed } from "@reales/domain";
import { api } from "@/lib/api";

/** The caller's calendar subscription link. POST rotates it (the old link stops working). */
export const GET = api({}, async ({ ctx, sq, req }) => ({ url: `${req.nextUrl.origin}/api/v1/feeds/calendar/${(await myCalendarFeed(sq, ctx)).token}.ics` }));
export const POST = api({ idempotent: true }, async ({ ctx, sq, req }) => ({ url: `${req.nextUrl.origin}/api/v1/feeds/calendar/${(await myCalendarFeed(sq, ctx, true)).token}.ics` }));
