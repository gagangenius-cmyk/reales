import { listPayments, recordPayment } from "@reales/domain";
import { paymentListQuery, recordPaymentSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: paymentListQuery }, async ({ ctx, sq, query }) => ({ payments: await listPayments(sq, ctx, query) }));
export const POST = api({ body: recordPaymentSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await recordPayment(sq, ctx, body) }));
