import { setMatchStatus } from "@reales/domain";
import { matchStatusSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string; listingId: string }, typeof matchStatusSchema>({ body: matchStatusSchema }, async ({ ctx, sq, params, body }) => setMatchStatus(sq, ctx, uuid.parse(params.id), uuid.parse(params.listingId), body.status));
