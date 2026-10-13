import { createInvoice, listInvoices } from "@reales/domain";
import { invoiceListQuery, invoiceSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: invoiceListQuery }, async ({ ctx, sq, query }) => ({ invoices: await listInvoices(sq, ctx, query) }));
export const POST = api({ body: invoiceSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createInvoice(sq, ctx, body) }));
