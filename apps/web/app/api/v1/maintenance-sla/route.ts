import { slaReport } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ sla: await slaReport(sq, ctx) }));
