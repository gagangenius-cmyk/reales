import { addTemplateVersion } from "@reales/domain";
import { templateVersionSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof templateVersionSchema>({ body: templateVersionSchema }, async ({ ctx, sq, body, params }) => ({ status: 201, data: await addTemplateVersion(sq, ctx, uuid.parse(params.id), body) }));
