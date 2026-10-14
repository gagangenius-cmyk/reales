import { markCommissionPaid } from "@reales/domain";
import { commissionPaySchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof commissionPaySchema>({ body: commissionPaySchema }, async ({ ctx, sq, params, body }) => markCommissionPaid(sq, ctx, uuid.parse(params.id), body.reference));
