import { addSupportComment, closeOwnSupportTicket, getSupportTicket, updateSupportTicket } from "@reales/domain";
import { supportCommentSchema, supportUpdateSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const id = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getSupportTicket(sq, ctx, id.parse(params.id)));
export const PATCH = api<{ id: string }, typeof supportUpdateSchema>({ body: supportUpdateSchema }, async ({ ctx, sq, params, body }) => updateSupportTicket(sq, ctx, id.parse(params.id), body));
export const POST = api<{ id: string }, typeof supportCommentSchema>({ body: supportCommentSchema, idempotent: true }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await addSupportComment(sq, ctx, id.parse(params.id), body) }));
export const DELETE = api<{ id: string }>({}, async ({ ctx, sq, params }) => closeOwnSupportTicket(sq, ctx, id.parse(params.id)));
