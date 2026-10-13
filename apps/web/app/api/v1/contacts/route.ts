import { createContact, listContacts } from "@reales/domain";
import { contactListQuery, contactSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: contactListQuery }, async ({ ctx, sq, query }) => ({ contacts: await listContacts(sq, ctx, query) }));
export const POST = api({ body: contactSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createContact(sq, ctx, body) }));
