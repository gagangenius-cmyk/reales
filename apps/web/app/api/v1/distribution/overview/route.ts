import { portalOverview } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => portalOverview(sq, ctx));
