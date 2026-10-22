import { adjustLeaveBalance, getLeaveBalances } from "@reales/domain";
import { leaveBalanceAdjustSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getLeaveBalances(sq, ctx, z.string().uuid().parse(params.id)));
export const POST = api<{ id: string }, typeof leaveBalanceAdjustSchema>({ body: leaveBalanceAdjustSchema, idempotent: true }, async ({ ctx, sq, params, body }) => adjustLeaveBalance(sq, ctx, z.string().uuid().parse(params.id), body.leaveTypeId, body.year, body));
