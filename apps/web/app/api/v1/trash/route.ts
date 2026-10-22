import { listTrash, softDelete } from "@reales/domain";
import { trashDeleteSchema, trashListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: trashListQuery }, async ({ ctx, sq, query }) => listTrash(sq, ctx, query));
export const POST = api({ body: trashDeleteSchema, idempotent: true }, async ({ ctx, sq, body }) => softDelete(sq, ctx, body.entity, body.id, body.reason));
