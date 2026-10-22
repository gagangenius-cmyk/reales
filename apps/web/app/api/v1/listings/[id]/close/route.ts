import { closeListing } from "@reales/domain";
import { closeListingSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof closeListingSchema>({ body: closeListingSchema, idempotent: true }, async ({ ctx, sq, params, body }) => closeListing(sq, ctx, z.string().uuid().parse(params.id), body));
