import { tenantPortal } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => tenantPortal(sq, ctx));
