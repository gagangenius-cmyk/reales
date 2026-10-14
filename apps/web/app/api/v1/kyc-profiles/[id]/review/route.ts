import { reviewKyc } from "@reales/domain";
import { kycReviewSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof kycReviewSchema>({ body: kycReviewSchema }, async ({ ctx, sq, params, body }) => reviewKyc(sq, ctx, uuid.parse(params.id), body));
