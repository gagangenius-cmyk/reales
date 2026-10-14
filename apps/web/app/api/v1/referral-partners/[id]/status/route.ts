import { setPartnerStatus } from "@reales/domain";
import { partnerStatusSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof partnerStatusSchema>({ body: partnerStatusSchema }, async ({ ctx, sq, params, body }) => setPartnerStatus(sq, ctx, uuid.parse(params.id), body.status));
