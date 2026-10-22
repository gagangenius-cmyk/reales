import { updateListingDetails } from "@reales/domain";
import { listingDetailsSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const PUT = api<{ id: string }, typeof listingDetailsSchema>({ body: listingDetailsSchema }, async ({ ctx, sq, params, body }) => updateListingDetails(sq, ctx, z.string().uuid().parse(params.id), body));
