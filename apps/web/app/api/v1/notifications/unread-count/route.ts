import { countMyUnread } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ unread: await countMyUnread(sq, ctx) }));
