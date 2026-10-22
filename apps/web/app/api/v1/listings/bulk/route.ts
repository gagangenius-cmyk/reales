import { bulkListingAction } from "@reales/domain";
import { bulkListingSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: bulkListingSchema, idempotent: true }, async ({ ctx, sq, body }) => bulkListingAction(sq, ctx, body.ids, body.action));
