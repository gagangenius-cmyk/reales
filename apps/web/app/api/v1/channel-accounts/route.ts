import { createChannelAccount, listChannelAccounts } from "@reales/domain";
import { channelAccountSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => listChannelAccounts(sq, ctx));
export const POST = api({ body: channelAccountSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createChannelAccount(sq, ctx, body) }));
