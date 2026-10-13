import { voidInvoice } from "@reales/domain";
import { voidInvoiceSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof voidInvoiceSchema>({ body: voidInvoiceSchema }, async ({ ctx, sq, body, params }) => voidInvoice(sq, ctx, uuid.parse(params.id), body.reason));
