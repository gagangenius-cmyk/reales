import { transferLeads } from "@reales/domain";
import { leadTransferSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: leadTransferSchema, idempotent: true, limit: { limit: 20, windowSec: 60, key: "lead-transfer" } }, async ({ ctx, sq, body }) => transferLeads(sq, ctx, body));
