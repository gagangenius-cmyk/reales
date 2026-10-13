import { scheduleInspection, listInspections } from "@reales/domain";
import { inspectionSchema, inspectionListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: inspectionListQuery }, async ({ ctx, sq, query }) => ({ inspections: await listInspections(sq, ctx, query) }));
export const POST = api({ body: inspectionSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await scheduleInspection(sq, ctx, body) }));
