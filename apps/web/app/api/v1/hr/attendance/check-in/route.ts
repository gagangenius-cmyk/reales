import { checkIn } from "@reales/domain";
import { noteSchema } from "@reales/validation";
import { clientIp } from "@/lib/api";
import { api } from "@/lib/api";

export const POST = api({ body: noteSchema, idempotent: true }, async ({ ctx, sq, body, req }) => checkIn(sq, ctx, { note: body.note, ip: clientIp(req) }));
