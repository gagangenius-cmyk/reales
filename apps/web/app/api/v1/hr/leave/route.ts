import { listLeaveRequests, requestLeave } from "@reales/domain";
import { leaveListQuery, leaveRequestSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: leaveListQuery }, async ({ ctx, sq, query }) => listLeaveRequests(sq, ctx, query));
export const POST = api({ body: leaveRequestSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await requestLeave(sq, ctx, body) }));
