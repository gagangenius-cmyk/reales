import { getBot, saveBotDraft } from "@reales/domain";
import { botDraftSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getBot(sq, ctx, uuid.parse(params.id)));
export const PUT = api<{ id: string }, typeof botDraftSchema>({ body: botDraftSchema }, async ({ ctx, sq, params, body }) => saveBotDraft(sq, ctx, uuid.parse(params.id), body.graph as any));
