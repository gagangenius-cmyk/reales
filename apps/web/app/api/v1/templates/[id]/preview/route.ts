import { previewTemplate } from "@reales/domain";
import { templatePreviewSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof templatePreviewSchema>({ body: templatePreviewSchema }, async ({ ctx, sq, body, params }) => previewTemplate(sq, ctx, uuid.parse(params.id), body.values));
