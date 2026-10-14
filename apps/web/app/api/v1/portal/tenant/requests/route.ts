import { tenantRequestMaintenance } from "@reales/domain";
import { portalRequestSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: portalRequestSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await tenantRequestMaintenance(sq, ctx, body) }));
