import { createTask, listTasks } from "@reales/domain";
import { taskListQuery, taskSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: taskListQuery }, async ({ ctx, sq, query }) => ({ tasks: await listTasks(sq, ctx, query) }));
export const POST = api({ body: taskSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createTask(sq, ctx, body) }));
