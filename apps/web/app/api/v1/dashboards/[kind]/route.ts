import { getDashboard } from "@reales/domain";
import { dashboardKindSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ kind: string }>({}, async ({ ctx, sq, params }) => getDashboard(sq, ctx, dashboardKindSchema.parse(params.kind)));
