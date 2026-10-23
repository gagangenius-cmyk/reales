import { trialBalance } from "@reales/domain";
import { trialBalanceQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: trialBalanceQuery }, async ({ ctx, sq, query }) => trialBalance(sq, ctx, query.asOf));
