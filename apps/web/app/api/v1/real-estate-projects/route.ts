import { createReProject } from "@reales/domain";
import { reProjectSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: reProjectSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createReProject(sq, ctx, body) }));
