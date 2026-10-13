import { listCommissions } from "@reales/domain";
import { commissionListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: commissionListQuery }, async ({ ctx, sq, query }) => ({ commissions: await listCommissions(sq, ctx, query) }));
