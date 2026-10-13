import { getContact, updateContact } from "@reales/domain";
import { updateContactSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getContact(sq, ctx, uuid.parse(params.id)));
export const PATCH = api<{ id: string }, typeof updateContactSchema>({ body: updateContactSchema }, async ({ ctx, sq, body, params }) =>
  updateContact(sq, ctx, uuid.parse(params.id), body),
);
