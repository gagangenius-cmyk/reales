import { listHolidays, saveHoliday } from "@reales/domain";
import { holidaySchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq, req }) => listHolidays(sq, ctx, Number(req.nextUrl.searchParams.get("year")) || undefined));
export const POST = api({ body: holidaySchema, idempotent: true }, async ({ ctx, sq, body }) => saveHoliday(sq, ctx, body));
