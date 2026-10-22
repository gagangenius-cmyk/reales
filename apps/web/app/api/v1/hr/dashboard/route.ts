import { hrDashboard } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => hrDashboard(sq, ctx));
