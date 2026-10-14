import { rescheduleTask } from "@reales/domain";
import { rescheduleSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof rescheduleSchema>({ body: rescheduleSchema }, async ({ ctx, sq, params, body }) => rescheduleTask(sq, ctx, uuid.parse(params.id), body.dueAt));
