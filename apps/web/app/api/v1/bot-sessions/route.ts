import { startBotSession } from "@reales/domain";
import { botStartSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: botStartSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await startBotSession(sq, ctx, body) }));
