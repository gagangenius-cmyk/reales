import { attachLeaseDocument } from "@reales/domain";
import { leaseDocumentSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof leaseDocumentSchema>({ body: leaseDocumentSchema }, async ({ ctx, sq, params, body }) => attachLeaseDocument(sq, ctx, uuid.parse(params.id), body.documentId, body.registrationRef));
