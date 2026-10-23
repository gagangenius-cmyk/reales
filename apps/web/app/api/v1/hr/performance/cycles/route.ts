import { createReviewCycle, listReviewCycles } from "@reales/domain";
import { reviewCycleSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => listReviewCycles(sq, ctx));
export const POST = api({ body: reviewCycleSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createReviewCycle(sq, ctx, body) }));
