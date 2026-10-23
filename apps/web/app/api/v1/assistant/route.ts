import { askAssistant } from "@reales/domain";
import { assistantSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: assistantSchema, limit: { limit: 60, windowSec: 60, key: "assistant" } }, async ({ ctx, sq, body }) => askAssistant(sq, ctx, body.message));
