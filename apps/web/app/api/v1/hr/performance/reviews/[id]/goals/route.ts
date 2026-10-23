import { saveGoals } from "@reales/domain";
import { goalsSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const PUT = api<{ id: string }, typeof goalsSchema>({ body: goalsSchema }, async ({ ctx, sq, params, body }) => saveGoals(sq, ctx, z.string().uuid().parse(params.id), body.goals));
