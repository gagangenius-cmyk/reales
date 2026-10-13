import { syncInspection } from "@reales/domain";
import { inspectionSyncSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof inspectionSyncSchema>({ body: inspectionSyncSchema }, async ({ ctx, sq, params, body }) => syncInspection(sq, ctx, uuid.parse(params.id), body.mutations));
