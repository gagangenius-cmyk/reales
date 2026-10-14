import { createPartner, listPartners } from "@reales/domain";
import { partnerSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ partners: await listPartners(sq, ctx) }));
export const POST = api({ body: partnerSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await createPartner(sq, ctx, body) }));
