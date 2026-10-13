import { recordRentPayment } from "@reales/domain";
import { rentPaymentSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof rentPaymentSchema>({ body: rentPaymentSchema, idempotent: true }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await recordRentPayment(sq, ctx, uuid.parse(params.id), body) }));
