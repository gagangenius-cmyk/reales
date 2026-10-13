import { updateProject } from "@reales/domain";
import { updateProjectSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const idParam = z.string().uuid();

export const PATCH = api<{ id: string }, typeof updateProjectSchema>({ body: updateProjectSchema }, async ({ ctx, sq, body, params }) =>
  updateProject(sq, ctx, idParam.parse(params.id), body),
);
