import { createDeveloper } from "@reales/domain";
import { developerSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: developerSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createDeveloper(sq, ctx, body) }));
