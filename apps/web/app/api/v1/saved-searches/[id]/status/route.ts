import { setSavedSearchStatus } from "@reales/domain";
import { searchStatusSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof searchStatusSchema>({ body: searchStatusSchema }, async ({ ctx, sq, params, body }) => setSavedSearchStatus(sq, ctx, uuid.parse(params.id), body.status));
