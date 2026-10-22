import { listLeaveTypes, saveLeaveType } from "@reales/domain";
import { leaveTypeSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq, req }) => listLeaveTypes(sq, ctx, req.nextUrl.searchParams.get("all") === "1"));
export const POST = api({ body: leaveTypeSchema, idempotent: true }, async ({ ctx, sq, body }) => saveLeaveType(sq, ctx, body));
