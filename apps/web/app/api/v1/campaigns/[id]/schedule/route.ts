import { scheduleCampaign } from "@reales/domain";
import { scheduleCampaignSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof scheduleCampaignSchema>({ body: scheduleCampaignSchema }, async ({ ctx, sq, body, params }) => scheduleCampaign(sq, ctx, uuid.parse(params.id), body.at));
