import { emailLetter } from "@reales/domain";
import { letterEmailSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof letterEmailSchema>({ body: letterEmailSchema, limit: { limit: 30, windowSec: 60, key: "hr-letter-email" } }, async ({ ctx, sq, params, body }) => emailLetter(sq, ctx, z.string().uuid().parse(params.id), body.to));
