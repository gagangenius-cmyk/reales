import { listConversations } from "@reales/domain";
import { conversationListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: conversationListQuery }, async ({ ctx, sq, query }) => ({ conversations: await listConversations(sq, ctx, query) }));
