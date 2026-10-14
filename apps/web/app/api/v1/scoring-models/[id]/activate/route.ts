import { activateScoringModel } from "@reales/domain";
import { modelActivateSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof modelActivateSchema>({ body: modelActivateSchema }, async ({ ctx, sq, params, body }) => activateScoringModel(sq, ctx, uuid.parse(params.id), body));
