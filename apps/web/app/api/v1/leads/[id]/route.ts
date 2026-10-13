import { getLead, updateLead } from "@reales/domain";
import { updateLeadSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getLead(sq, ctx, uuid.parse(params.id)));
export const PATCH = api<{ id: string }, typeof updateLeadSchema>({ body: updateLeadSchema }, async ({ ctx, sq, body, params }) =>
  updateLead(sq, ctx, uuid.parse(params.id), body),
);
