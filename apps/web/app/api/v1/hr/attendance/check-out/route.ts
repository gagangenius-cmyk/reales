import { checkOut } from "@reales/domain";
import { noteSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: noteSchema, idempotent: true }, async ({ ctx, sq, body }) => checkOut(sq, ctx, body));
