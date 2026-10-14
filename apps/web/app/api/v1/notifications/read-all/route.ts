import { markAllRead } from "@reales/domain";
import { api } from "@/lib/api";

export const POST = api({}, async ({ ctx, sq }) => ({ marked: await markAllRead(sq, ctx) }));
