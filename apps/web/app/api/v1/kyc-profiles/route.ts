import { listKycProfiles } from "@reales/domain";
import { kycListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: kycListQuery }, async ({ ctx, sq, query }) => ({ profiles: await listKycProfiles(sq, ctx, query) }));
