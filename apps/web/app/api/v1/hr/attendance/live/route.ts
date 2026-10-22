import { liveBoard } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => liveBoard(sq, ctx));
