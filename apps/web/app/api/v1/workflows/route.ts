import { createWorkflow, listWorkflows } from "@reales/domain";
import { createWorkflowSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ workflows: await listWorkflows(sq, ctx) }));
export const POST = api({ body: createWorkflowSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createWorkflow(sq, ctx, body as any) }));
