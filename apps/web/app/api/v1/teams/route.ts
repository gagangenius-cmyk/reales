import { createTeam } from "@reales/domain";
import { createTeamSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: createTeamSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createTeam(sq, ctx, body) }));
