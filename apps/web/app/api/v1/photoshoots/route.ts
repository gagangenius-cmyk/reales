import { listPhotoshoots, requestPhotoshoot } from "@reales/domain";
import { photoshootListQuery, photoshootRequestSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: photoshootListQuery }, async ({ ctx, sq, query }) => ({ photoshoots: await listPhotoshoots(sq, ctx, { status: query.status, listingId: query.listingId, mine: query.mine === "true" }) }));
export const POST = api({ body: photoshootRequestSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await requestPhotoshoot(sq, ctx, body) }));
