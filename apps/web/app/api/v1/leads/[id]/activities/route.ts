import { addLeadActivity } from "@reales/domain";
import { activitySchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof activitySchema>({ body: activitySchema }, async ({ ctx, sq, body, params }) => {
  await addLeadActivity(sq, ctx, uuid.parse(params.id), body);
  return { status: 201, data: { ok: true } };
});
