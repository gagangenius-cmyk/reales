import { getListing, updateListing } from "@reales/domain";
import { updateListingSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getListing(sq, ctx, uuid.parse(params.id)));
export const PATCH = api<{ id: string }, typeof updateListingSchema>({ body: updateListingSchema }, async ({ ctx, sq, body, params }) =>
  updateListing(sq, ctx, uuid.parse(params.id), body),
);
