import { listAuditEvents } from "@reales/domain";
import { paginationSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: paginationSchema }, async ({ ctx, sq, query }) => ({ events: await listAuditEvents(sq, ctx, query) }));
