import { submitSelfReview } from "@reales/domain";
import { ratingSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof ratingSchema>({ body: ratingSchema, idempotent: true }, async ({ ctx, sq, params, body }) => submitSelfReview(sq, ctx, z.string().uuid().parse(params.id), body));
