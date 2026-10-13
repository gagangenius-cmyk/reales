import { completeViewing } from "@reales/domain";
import { completeViewingSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof completeViewingSchema>({ body: completeViewingSchema }, async ({ ctx, sq, body, params }) => completeViewing(sq, ctx, uuid.parse(params.id), body));
