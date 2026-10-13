import { createListing, listListings } from "@reales/domain";
import { createListingSchema, listingListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: listingListQuery }, async ({ ctx, sq, query }) => ({ listings: await listListings(sq, ctx, query) }));
export const POST = api({ body: createListingSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createListing(sq, ctx, body) }));
