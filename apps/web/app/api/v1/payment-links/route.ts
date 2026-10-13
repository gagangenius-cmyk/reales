import { createPaymentLink } from "@reales/domain";
import { paymentLinkSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: paymentLinkSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createPaymentLink(sq, ctx, body) }));
