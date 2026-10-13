import { assignLead } from "@reales/domain";
import { assignSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof assignSchema>({ body: assignSchema }, async ({ ctx, sq, body, params }) => {
  const id = uuid.parse(params.id);
  return assignLead(sq, ctx, id, body);
});
