import { mergeContacts } from "@reales/domain";
import { mergeContactSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

/** Merge the duplicate in the body into the contact in the URL (which is kept). Needs tenant-wide contact access and a step-up confirmation. */
export const POST = api<{ id: string }, typeof mergeContactSchema>({ body: mergeContactSchema, idempotent: true }, async ({ ctx, sq, body, params }) => ({ status: 200, data: await mergeContacts(sq, ctx, { survivorId: uuid.parse(params.id), duplicateId: body.duplicateId }) }));
