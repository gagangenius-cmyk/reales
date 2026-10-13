import { setVendorStatus } from "@reales/domain";
import { vendorStatusSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof vendorStatusSchema>({ body: vendorStatusSchema }, async ({ ctx, sq, params, body }) => setVendorStatus(sq, ctx, uuid.parse(params.id), body.status));
