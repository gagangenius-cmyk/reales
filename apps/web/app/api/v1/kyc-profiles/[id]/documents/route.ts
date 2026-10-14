import { addKycDocument } from "@reales/domain";
import { kycDocumentSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof kycDocumentSchema>({ body: kycDocumentSchema }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await addKycDocument(sq, ctx, uuid.parse(params.id), body) }));
