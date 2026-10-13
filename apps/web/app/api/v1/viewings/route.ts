import { listViewings, scheduleViewing } from "@reales/domain";
import { scheduleViewingSchema, viewingListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: viewingListQuery }, async ({ ctx, sq, query }) => ({ viewings: await listViewings(sq, ctx, query) }));
export const POST = api({ body: scheduleViewingSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await scheduleViewing(sq, ctx, body) }));
