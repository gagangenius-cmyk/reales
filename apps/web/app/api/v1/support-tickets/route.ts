import { createSupportTicket, listSupportTickets } from "@reales/domain";
import { supportListQuery, supportTicketSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: supportListQuery }, async ({ ctx, sq, query }) => ({ tickets: await listSupportTickets(sq, ctx, { status: query.status, mine: query.mine === "true", limit: query.limit, offset: query.offset }) }));
export const POST = api({ body: supportTicketSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createSupportTicket(sq, ctx, body) }));
