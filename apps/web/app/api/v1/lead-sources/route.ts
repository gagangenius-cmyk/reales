import { createIngestSource, listIngestSources } from "@reales/domain";
import { ingestSourceSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => listIngestSources(sq, ctx));
export const POST = api({ body: ingestSourceSchema, idempotent: false }, async ({ ctx, sq, body }) => ({ status: 201, data: await createIngestSource(sq, ctx, body) }));
