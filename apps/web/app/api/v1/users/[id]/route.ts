import { updateUser } from "@reales/domain";
import { updateUserSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const idParam = z.string().uuid();

export const PATCH = api<{ id: string }, typeof updateUserSchema>({ body: updateUserSchema }, async ({ ctx, sq, body, params }) =>
  updateUser(sq, ctx, idParam.parse(params.id), body),
);
