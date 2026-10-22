import { restoreRecord } from "@reales/domain";
import { trashActionSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: trashActionSchema, idempotent: true }, async ({ ctx, sq, body }) => restoreRecord(sq, ctx, body.entity, body.id));
