import { approveTemplate } from "@reales/domain";
import { approveTemplateSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof approveTemplateSchema>({ body: approveTemplateSchema }, async ({ ctx, sq, body, params }) => approveTemplate(sq, ctx, uuid.parse(params.id), body.outcome));
