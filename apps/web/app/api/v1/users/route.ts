import { createUser, listUsers } from "@reales/domain";
import { createUserSchema, paginationSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: paginationSchema }, async ({ ctx, sq, query }) => ({ users: await listUsers(sq, ctx, query) }));
export const POST = api({ body: createUserSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createUser(sq, ctx, body) }));
