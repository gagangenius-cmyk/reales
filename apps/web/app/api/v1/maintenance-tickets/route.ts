import { createTicket, listTickets } from "@reales/domain";
import { ticketSchema, ticketListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: ticketListQuery }, async ({ ctx, sq, query }) => ({ tickets: await listTickets(sq, ctx, query) }));
export const POST = api({ body: ticketSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createTicket(sq, ctx, body) }));
