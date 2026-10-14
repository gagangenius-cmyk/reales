import { createDsr, listDsr } from "@reales/domain";
import { dsrListQuery, dsrSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: dsrListQuery }, async ({ ctx, sq, query }) => ({ requests: await listDsr(sq, ctx, query) }));
export const POST = api({ body: dsrSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await createDsr(sq, ctx, body) }));
