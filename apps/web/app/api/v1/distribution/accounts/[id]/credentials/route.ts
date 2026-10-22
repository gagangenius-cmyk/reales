import { savePortalCredentials } from "@reales/domain";
import { credentialsSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const PUT = api<{ id: string }, typeof credentialsSchema>({ body: credentialsSchema }, async ({ ctx, sq, params, body }) => savePortalCredentials(sq, ctx, z.string().uuid().parse(params.id), body));
