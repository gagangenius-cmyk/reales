import { startGoogleConnect } from "@reales/domain";
import { api } from "@/lib/api";

export const POST = api({}, async ({ ctx, sq }) => startGoogleConnect(sq, ctx));
