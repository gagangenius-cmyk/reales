import { createChannelAccount } from "@reales/domain";
import { channelAccountSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: channelAccountSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createChannelAccount(sq, ctx, body) }));
