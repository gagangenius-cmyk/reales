import { correctAttendance } from "@reales/domain";
import { correctionSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: correctionSchema, idempotent: true }, async ({ ctx, sq, body }) => correctAttendance(sq, ctx, body.employeeId, body.date, body));
