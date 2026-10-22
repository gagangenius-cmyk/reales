import { requireStepUp } from "@reales/auth";
import { purgeRecord } from "@reales/domain";
import { trashActionSchema } from "@reales/validation";
import { api } from "@/lib/api";

/** Permanent erase: tenant administrators only, and only after re-verifying the second factor. */
export const POST = api({ body: trashActionSchema, idempotent: true }, async ({ ctx, sq, body }) => { requireStepUp(ctx); return purgeRecord(sq, ctx, body.entity, body.id); });
