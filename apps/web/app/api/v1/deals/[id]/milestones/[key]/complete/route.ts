import { completeMilestone } from "@reales/domain";
import { milestoneCompleteSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();
const key = z.string().regex(/^[a-z0-9_]{1,60}$/);

export const POST = api<{ id: string; key: string }, typeof milestoneCompleteSchema>({ body: milestoneCompleteSchema }, async ({ ctx, sq, body, params }) =>
  completeMilestone(sq, ctx, uuid.parse(params.id), key.parse(params.key), body),
);
