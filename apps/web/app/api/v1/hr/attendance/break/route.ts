import { endBreak, startBreak } from "@reales/domain";
import { breakSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: breakSchema, idempotent: true }, async ({ ctx, sq, body }) => startBreak(sq, ctx, body.kind));
export const DELETE = api({}, async ({ ctx, sq }) => endBreak(sq, ctx));
