import { completeWork } from "@reales/domain";
import { completeWorkSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof completeWorkSchema>({ body: completeWorkSchema }, async ({ ctx, sq, params, body }) => completeWork(sq, ctx, uuid.parse(params.id), body));
