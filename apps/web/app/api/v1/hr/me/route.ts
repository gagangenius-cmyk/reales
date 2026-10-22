import { myAttendanceToday, myEmployee } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ employee: await myEmployee(sq, ctx), today: await myAttendanceToday(sq, ctx) }));
