import { setWorkflowStatus } from "@reales/domain";
import { workflowStatusSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof workflowStatusSchema>({ body: workflowStatusSchema }, async ({ ctx, sq, body, params }) => setWorkflowStatus(sq, ctx, uuid.parse(params.id), body.status));
