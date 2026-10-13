import { createEnvelope } from "@reales/domain";
import { createEnvelopeSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: createEnvelopeSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createEnvelope(sq, ctx, body) }));
