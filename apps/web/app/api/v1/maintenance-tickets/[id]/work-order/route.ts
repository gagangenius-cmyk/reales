import { issueWorkOrder } from "@reales/domain";
import { workOrderSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof workOrderSchema>({ body: workOrderSchema }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await issueWorkOrder(sq, ctx, uuid.parse(params.id), body) }));
