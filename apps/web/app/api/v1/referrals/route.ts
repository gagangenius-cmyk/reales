import { listReferrals, referLead } from "@reales/domain";
import { referralListQuery, referralSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: referralListQuery }, async ({ ctx, sq, query }) => ({ referrals: await listReferrals(sq, ctx, query) }));
export const POST = api({ body: referralSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await referLead(sq, ctx, body) }));
