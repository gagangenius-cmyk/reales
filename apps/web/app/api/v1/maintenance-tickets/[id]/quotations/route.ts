import { submitQuotation } from "@reales/domain";
import { quotationSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof quotationSchema>({ body: quotationSchema }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await submitQuotation(sq, ctx, uuid.parse(params.id), body) }));
