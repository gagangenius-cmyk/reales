import { counterOffer } from "@reales/domain";
import { counterOfferSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof counterOfferSchema>({ body: counterOfferSchema }, async ({ ctx, sq, body, params }) => counterOffer(sq, ctx, uuid.parse(params.id), body));
