import { listAgentDirectory, upsertAgentProfile } from "@reales/domain";
import { agentProfileSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ agents: await listAgentDirectory(sq, ctx) }));
export const PUT = api({ body: agentProfileSchema, idempotent: true }, async ({ ctx, sq, body }) => upsertAgentProfile(sq, ctx, body));
