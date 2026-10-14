import { setMonthlyQuota } from "@reales/domain";
import { quotaSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const PUT = api({ body: quotaSchema }, async ({ ctx, sq, body }) => setMonthlyQuota(sq, ctx, body.meter, body.limit));
