import { changeLeadStage } from "@reales/domain";
import { stageSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof stageSchema>({ body: stageSchema }, async ({ ctx, sq, body, params }) => {
  const id = uuid.parse(params.id);
  return changeLeadStage(sq, ctx, id, body);
});
