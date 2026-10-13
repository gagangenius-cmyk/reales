import { createOffer, listOffers } from "@reales/domain";
import { createOfferSchema, offerListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: offerListQuery }, async ({ ctx, sq, query }) => ({ offers: await listOffers(sq, ctx, query) }));
export const POST = api({ body: createOfferSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createOffer(sq, ctx, body) }));
