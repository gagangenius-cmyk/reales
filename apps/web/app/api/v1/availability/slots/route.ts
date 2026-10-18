import { freeSlots } from "@reales/domain";
import { freeSlotsQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: freeSlotsQuery }, async ({ ctx, sq, query }) => freeSlots(sq, ctx, query.agentUserId, query.date, query.durationMin));
