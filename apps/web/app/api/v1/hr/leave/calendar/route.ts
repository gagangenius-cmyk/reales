import { leaveCalendar } from "@reales/domain";
import { rangeQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: rangeQuery }, async ({ ctx, sq, query }) => leaveCalendar(sq, ctx, query.from, query.to));
