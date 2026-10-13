import { signInspection } from "@reales/domain";
import { inspectionSignSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof inspectionSignSchema>({ body: inspectionSignSchema }, async ({ ctx, sq, params, body }) => signInspection(sq, ctx, uuid.parse(params.id), body.contactId));
