import { finaliseReview } from "@reales/domain";
import { finaliseSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof finaliseSchema>({ body: finaliseSchema, idempotent: true }, async ({ ctx, sq, params, body }) => finaliseReview(sq, ctx, z.string().uuid().parse(params.id), body));
