import { getCalendar, toIcs } from "@reales/domain";
import { calendarQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: calendarQuery }, async ({ ctx, sq, query }) => new Response(toIcs(await getCalendar(sq, ctx, query)), { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": "attachment; filename=\"reales-calendar.ics\"", "cache-control": "private, no-store" } }));
