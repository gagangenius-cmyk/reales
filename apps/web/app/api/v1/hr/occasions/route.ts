import { celebrations, saveOccasion } from "@reales/domain";
import { occasionSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => celebrations(sq, ctx, 60));
export const POST = api({ body: occasionSchema, idempotent: true }, async ({ ctx, sq, body }) => saveOccasion(sq, ctx, body));
