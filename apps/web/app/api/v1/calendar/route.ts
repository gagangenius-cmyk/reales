import { getCalendar } from "@reales/domain";
import { calendarQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: calendarQuery }, async ({ ctx, sq, query }) => ({ events: await getCalendar(sq, ctx, query) }));
