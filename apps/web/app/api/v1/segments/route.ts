import { createSegment, listSegments } from "@reales/domain";
import { segmentSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ segments: await listSegments(sq, ctx) }));
export const POST = api({ body: segmentSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createSegment(sq, ctx, body) }));
