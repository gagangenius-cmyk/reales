import { completeInspection } from "@reales/domain";
import { inspectionCompleteSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof inspectionCompleteSchema>({ body: inspectionCompleteSchema }, async ({ ctx, sq, params, body }) => completeInspection(sq, ctx, uuid.parse(params.id), body));
