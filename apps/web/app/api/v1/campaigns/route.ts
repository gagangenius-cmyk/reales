import { createCampaign, listCampaigns } from "@reales/domain";
import { campaignSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ campaigns: await listCampaigns(sq, ctx) }));
export const POST = api({ body: campaignSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createCampaign(sq, ctx, body) }));
