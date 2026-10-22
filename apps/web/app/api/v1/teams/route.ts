import { createTeam, listTeamsDetailed } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const body = z.object({ name: z.string().trim().min(1).max(180), branchId: z.string().uuid().optional() }).strict();

export const GET = api({}, async ({ ctx, sq }) => ({ teams: await listTeamsDetailed(sq, ctx) }));
export const POST = api({ body, idempotent: true }, async ({ ctx, sq, body: b }) => ({ status: 201, data: await createTeam(sq, ctx, b) }));
