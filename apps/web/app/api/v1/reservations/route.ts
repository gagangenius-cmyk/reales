import { createReservation, listReservations } from "@reales/domain";
import { createReservationSchema, reservationListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: reservationListQuery }, async ({ ctx, sq, query }) => ({ reservations: await listReservations(sq, ctx, query) }));
export const POST = api({ body: createReservationSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createReservation(sq, ctx, body) }));
