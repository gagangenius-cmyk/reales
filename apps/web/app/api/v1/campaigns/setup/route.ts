import { broadcastSetup } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => broadcastSetup(sq, ctx));
