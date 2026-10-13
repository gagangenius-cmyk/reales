import { createTask } from "@reales/domain";
import { taskSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: taskSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createTask(sq, ctx, body) }));
