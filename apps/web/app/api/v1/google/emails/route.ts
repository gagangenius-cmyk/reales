import { listContactEmails } from "@reales/domain";
import { googleEmailsQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: googleEmailsQuery }, async ({ ctx, sq, query }) => ({ emails: await listContactEmails(sq, ctx, query.contactId) }));
