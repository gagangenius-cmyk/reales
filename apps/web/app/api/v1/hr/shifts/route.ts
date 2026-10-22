import { listShifts, saveShift } from "@reales/domain";
import { shiftSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => listShifts(sq, ctx));
export const POST = api({ body: shiftSchema, idempotent: true }, async ({ ctx, sq, body }) => saveShift(sq, ctx, body));
