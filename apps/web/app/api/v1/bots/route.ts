import { createBot, listBots } from "@reales/domain";
import { botSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ bots: await listBots(sq, ctx) }));
export const POST = api({ body: botSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await createBot(sq, ctx, body as any) }));
