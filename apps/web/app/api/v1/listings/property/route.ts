import { createListingFromProperty } from "@reales/domain";
import { newPropertyListingSchema } from "@reales/validation";
import { api } from "@/lib/api";

/** Creates a listing together with its property (location, building, unit) in one step. */
export const POST = api({ body: newPropertyListingSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createListingFromProperty(sq, ctx, body) }));
