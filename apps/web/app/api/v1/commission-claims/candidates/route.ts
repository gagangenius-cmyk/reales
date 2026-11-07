import { listClaimCandidates } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ candidates: await listClaimCandidates(sq, ctx) }));
