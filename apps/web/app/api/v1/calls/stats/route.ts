import { callStats } from "@reales/domain";
import { callStatsQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: callStatsQuery }, async ({ ctx, sq, query }) => callStats(sq, ctx, query));
