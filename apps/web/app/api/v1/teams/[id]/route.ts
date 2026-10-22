import { updateTeam } from "@reales/domain";
import { teamUpdateSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const PATCH = api<{ id: string }, typeof teamUpdateSchema>({ body: teamUpdateSchema }, async ({ ctx, sq, params, body }) => updateTeam(sq, ctx, z.string().uuid().parse(params.id), body));
